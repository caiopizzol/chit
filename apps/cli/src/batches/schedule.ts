// Scheduling: which pending tasks may launch next, and the batch's derived
// status. Pure functions over the batch state, so the engine's launch
// decisions are unit-testable without jobs or worktrees. Salvaged from the
// batch-v0 prototype, adapted to the simplified (no-merge) task statuses.

import { tasksClaimsOverlap } from "./overlap.ts";
import {
	ACTIVE_TASK_STATUSES,
	type Batch,
	type BatchStatus,
	type BatchTask,
	DEPENDENCY_SATISFIED_STATUSES,
} from "./types.ts";

function byId(tasks: BatchTask[]): Map<string, BatchTask> {
	return new Map(tasks.map((t) => [t.id, t]));
}

function depsSatisfied(task: BatchTask, index: Map<string, BatchTask>): boolean {
	return task.dependencies.every((dep) => {
		const d = index.get(dep);
		return d !== undefined && DEPENDENCY_SATISFIED_STATUSES.has(d.status);
	});
}

// A task that is permanently blocked: a dependency reached a terminal state that is
// NOT review_ready (failed, cancelled, or needs_attention), so the dependent can
// never become runnable -- only review_ready satisfies a dependency. Surfaced so the
// batch reports needs_human rather than spinning. (Pending + unsatisfiable deps.)
export function isBlocked(task: BatchTask, batch: Batch): boolean {
	if (task.status !== "pending") return false;
	const index = byId(batch.tasks);
	return task.dependencies.some((dep) => {
		const d = index.get(dep);
		return (
			d !== undefined &&
			(d.status === "failed" || d.status === "cancelled" || d.status === "needs_attention")
		);
	});
}

// A task that could start right now if there were a free slot and no claim
// conflict (pending + all deps review_ready).
export function isStartable(task: BatchTask, batch: Batch): boolean {
	return task.status === "pending" && depsSatisfied(task, byId(batch.tasks));
}

// The pending tasks to launch next: deps satisfied, within the remaining parallel
// slots, and not overlapping the claimed paths of any already-active or
// just-selected task (claim-overlapping tasks are serialized into later waves).
export function selectRunnable(batch: Batch): BatchTask[] {
	const index = byId(batch.tasks);
	const active = batch.tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
	let freeSlots = Math.max(0, batch.maxParallel - active.length);
	if (freeSlots === 0) return [];

	const selected: BatchTask[] = [];
	const blockers = [...active]; // active + already-selected; a new pick must not overlap any
	for (const task of batch.tasks) {
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

// The batch status derived from its tasks. running while anything is active or
// startable; needs_human when stuck (pending tasks blocked by an unfinished dep) OR
// any terminal task needs_attention (it did not converge clean -- this outranks
// review_ready so the headline never reads "ready" while a task is unresolved);
// ready_for_review when every task is terminal, at least one is review_ready, and
// none needs attention; failed if a task failed and nothing else can move; cancelled
// when all terminal tasks are cancelled/failed with no review_ready and a cancel
// happened (the engine sets cancelled explicitly).
export function deriveBatchStatus(batch: Batch): BatchStatus {
	const tasks = batch.tasks;
	if (tasks.length === 0) return "ready_for_review";

	const anyActive = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
	const anyStartable = tasks.some((t) => isStartable(t, batch));
	if (anyActive || anyStartable) return "running";

	// Nothing active or startable. Are there pending tasks that can never run?
	const stuckPending = tasks.some((t) => t.status === "pending");
	const anyNeedsAttention = tasks.some((t) => t.status === "needs_attention");
	const anyReviewReady = tasks.some((t) => t.status === "review_ready");
	const anyFailed = tasks.some((t) => t.status === "failed");

	if (stuckPending) return "needs_human"; // pending with unsatisfiable deps
	// A terminal task that did not converge clean needs a human decision; that
	// outranks review_ready for the headline (verdict integrity: never read "ready"
	// while any task is unresolved). review_ready siblings stay reviewable per-task.
	if (anyNeedsAttention) return "needs_human";
	if (anyReviewReady) return "ready_for_review";
	if (anyFailed) return "failed";
	return "ready_for_review"; // all terminal: none review_ready/needs_attention/failed (e.g. all cancelled)
}
