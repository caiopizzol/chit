// Scheduling: which pending tasks may launch next, and the campaign's derived
// status. Pure functions over the campaign state, so the engine's launch
// decisions are unit-testable without jobs or worktrees. Salvaged from the
// campaign-v0 prototype, adapted to the simplified (no-merge) task statuses.

import { tasksClaimsOverlap } from "./overlap.ts";
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

function depsSatisfied(task: CampaignTask, index: Map<string, CampaignTask>): boolean {
	return task.dependencies.every((dep) => {
		const d = index.get(dep);
		return d !== undefined && DEPENDENCY_SATISFIED_STATUSES.has(d.status);
	});
}

// A task that is permanently blocked: a dependency failed or was cancelled, so it
// can never become runnable. Surfaced so the campaign reports needs_human rather
// than spinning. (Pending + unsatisfiable deps.)
export function isBlocked(task: CampaignTask, campaign: Campaign): boolean {
	if (task.status !== "pending") return false;
	const index = byId(campaign.tasks);
	return task.dependencies.some((dep) => {
		const d = index.get(dep);
		return d !== undefined && (d.status === "failed" || d.status === "cancelled");
	});
}

// A task that could start right now if there were a free slot and no claim
// conflict (pending + all deps review_ready).
export function isStartable(task: CampaignTask, campaign: Campaign): boolean {
	return task.status === "pending" && depsSatisfied(task, byId(campaign.tasks));
}

// The pending tasks to launch next: deps satisfied, within the remaining parallel
// slots, and not overlapping the claimed paths of any already-active or
// just-selected task (claim-overlapping tasks are serialized into later waves).
export function selectRunnable(campaign: Campaign): CampaignTask[] {
	const index = byId(campaign.tasks);
	const active = campaign.tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
	let freeSlots = Math.max(0, campaign.maxParallel - active.length);
	if (freeSlots === 0) return [];

	const selected: CampaignTask[] = [];
	const blockers = [...active]; // active + already-selected; a new pick must not overlap any
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

// The campaign status derived from its tasks. running while anything is active or
// startable; failed if a task failed and nothing else can move; needs_human if
// stuck (pending tasks that are blocked by a failed/cancelled dep, or no slots
// logic can free); ready_for_review when every task is terminal and at least one
// is review_ready; cancelled when all terminal tasks are cancelled/failed with no
// review_ready and a cancel happened (the engine sets cancelled explicitly).
export function deriveCampaignStatus(campaign: Campaign): CampaignStatus {
	const tasks = campaign.tasks;
	if (tasks.length === 0) return "ready_for_review";

	const anyActive = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
	const anyStartable = tasks.some((t) => isStartable(t, campaign));
	if (anyActive || anyStartable) return "running";

	// Nothing active or startable. Are there pending tasks that can never run?
	const stuckPending = tasks.some((t) => t.status === "pending");
	const anyReviewReady = tasks.some((t) => t.status === "review_ready");
	const anyFailed = tasks.some((t) => t.status === "failed");

	if (stuckPending) return "needs_human"; // pending with unsatisfiable deps
	if (anyReviewReady) return "ready_for_review";
	if (anyFailed) return "failed";
	return "ready_for_review"; // all terminal, none review_ready, none failed (e.g. all cancelled)
}
