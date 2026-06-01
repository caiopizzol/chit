// Pure scheduling logic over a campaign's tasks. No filesystem, no git, no agent
// spawning: given the current task states it decides which tasks may start now,
// and derives the campaign-level status. The CLI run loop drives it.
//
// Safety rules (see notes/campaign-v0.md): a task starts only when it is
// pending, all its dependencies are satisfied (merge_ready/merged), it does not
// claim paths overlapping any active task, and a parallel slot is free. The
// scheduler never co-selects two tasks whose claims overlap.

import { tasksClaimsOverlap } from "./plan.ts";
import {
	ACTIVE_TASK_STATUSES,
	type Campaign,
	type CampaignStatus,
	type CampaignTask,
	DEPENDENCY_SATISFIED_STATUSES,
} from "./types.ts";

function byId(tasks: CampaignTask[]): Map<string, CampaignTask> {
	return new Map(tasks.map((t) => [t.id, t]));
}

// Every dependency present and in a satisfied (merge_ready/merged) state. v0
// never assigns those states, so a task with any dependency stays unstartable.
function depsSatisfied(task: CampaignTask, index: Map<string, CampaignTask>): boolean {
	return task.dependencies.every((dep) => {
		const d = index.get(dep);
		return d !== undefined && DEPENDENCY_SATISFIED_STATUSES.has(d.status);
	});
}

// Startable in principle: pending, with all dependencies satisfied. Ignores the
// transient constraints (parallel slots, claim overlap) that selectRunnable
// also applies; used by status derivation to tell "work remains" from "stuck".
export function isStartable(task: CampaignTask, campaign: Campaign): boolean {
	return task.status === "pending" && depsSatisfied(task, byId(campaign.tasks));
}

// The tasks that may be started right now, in task order, respecting parallel
// capacity and non-overlap with active and already-selected tasks.
export function selectRunnable(campaign: Campaign): CampaignTask[] {
	const index = byId(campaign.tasks);
	const active = campaign.tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
	let freeSlots = Math.max(0, campaign.maxParallel - active.length);
	if (freeSlots === 0) return [];

	const selected: CampaignTask[] = [];
	const blockers = [...active]; // active + already-selected; new picks must not overlap any
	for (const task of campaign.tasks) {
		if (freeSlots === 0) break;
		if (task.status !== "pending") continue;
		if (!depsSatisfied(task, index)) continue;
		if (blockers.some((b) => tasksClaimsOverlap(task, b))) continue;
		selected.push(task);
		blockers.push(task);
		freeSlots--;
	}
	return selected;
}

// Campaign status reduced from its tasks. "running" while anything is active or
// immediately startable; otherwise classified by what remains: a hard failure
// is "failed"; anything stuck on a human (blocked, needs_human, or a pending
// task whose deps are unsatisfied) is "needs_human"; an all-converged set still
// awaiting human merge is "ready_for_review"; and only a fully merged set is
// "complete" (which v0 never reaches on its own, since it does not track merges).
export function deriveCampaignStatus(campaign: Campaign): CampaignStatus {
	const tasks = campaign.tasks;
	if (tasks.length === 0) return "complete";

	const anyActive = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
	const anyStartable = tasks.some((t) => isStartable(t, campaign));
	if (anyActive || anyStartable) return "running";

	if (tasks.some((t) => t.status === "failed")) return "failed";

	const stuck = tasks.some(
		(t) => t.status === "blocked" || t.status === "needs_human" || t.status === "pending",
	);
	if (stuck) return "needs_human";

	// Every task is in a terminal-good state (review_ready / merge_ready /
	// merged). Only call it complete once they are all actually merged; otherwise
	// chit is done but a human still has to review and merge.
	if (tasks.every((t) => t.status === "merged")) return "complete";
	return "ready_for_review";
}
