// Sequencing: which pending step may launch next, and the plan's derived status. Pure
// functions over the plan record, so the forward-flow decisions are unit-testable without
// jobs or worktrees. This is a SKELETON: selectNextStep decides what is runnable; it never
// launches anything. Modelled on batches/schedule.ts, adapted to the plan's code-dependency
// semantics (a dependent waits for its dependency to be APPLIED, not merely review_ready).

import {
	BLOCKS_LAUNCH_STATUSES,
	DEPENDENCY_APPLIED_STATUSES,
	type Plan,
	type PlanStatus,
	type PlanStepRecord,
} from "./types.ts";

function byId(steps: PlanStepRecord[]): Map<string, PlanStepRecord> {
	return new Map(steps.map((s) => [s.id, s]));
}

// A step's code dependencies are all satisfied: every dependency is APPLIED to the
// integration branch. A merely review_ready dependency does NOT satisfy (a batch dependency
// never merges a diff, so a step cut from a reviewed-but-unapplied upstream would start blind
// to its code) -- this apply-between-steps wait is the whole reason the plan-runner exists.
function depsApplied(step: PlanStepRecord, index: Map<string, PlanStepRecord>): boolean {
	return step.dependsOn.every((dep) => {
		const d = index.get(dep);
		return d !== undefined && DEPENDENCY_APPLIED_STATUSES.has(d.status);
	});
}

// The single next step to launch, for the v1 strict chain. Returns the first pending step
// whose dependencies are ALL applied -- but only when no step is currently in flight or
// paused (running, review_ready, needs_human, failed, or cancelled). Any such step blocks
// new launches: a running step holds the chain, a review_ready step waits on the operator's
// gated apply, and a terminal non-clean step pauses the plan instead of skipping ahead.
//
// v1 selects ONE step even when several independent pending steps are runnable: parallel
// waves are slice 3, not v1. This helper is a skeleton -- it decides runnability only and
// must not launch anything.
export function selectNextStep(plan: Plan): PlanStepRecord | undefined {
	if (plan.steps.some((s) => BLOCKS_LAUNCH_STATUSES.has(s.status))) return undefined;
	const index = byId(plan.steps);
	return plan.steps.find((s) => s.status === "pending" && depsApplied(s, index));
}

// The plan status derived from its steps.
//
// Precedence is verdict-integrity first: a non-clean step (cancelled, failed, needs_human)
// pauses the plan and must never be masked by a forward signal -- the headline must not read
// "running"/"ready" while a step needs a human. cancelled settles the whole plan; failed and
// needs_human each pause it. Only when no step is non-clean do the forward signals apply: a
// running step keeps the plan running, a review_ready step waits on the gated apply, and a
// launchable pending step keeps it running.
//
//   completed       - every step is applied (terminal success)
//   cancelled       - any step cancelled (the plan was cancelled)
//   failed          - any step failed and the plan cannot progress
//   needs_human     - any step paused for a human decision, OR a pending step is stuck
//                     (its dependency can never be applied -- impossible in a parse-validated
//                     acyclic chain, but guarded)
//   running         - a step's run is advancing, OR a pending step can launch next
//   ready_for_apply - a terminal, clean step is waiting on the operator's gated apply
export function derivePlanStatus(plan: Plan): PlanStatus {
	const steps = plan.steps;
	if (steps.every((s) => s.status === "applied")) return "completed";

	if (steps.some((s) => s.status === "cancelled")) return "cancelled";
	if (steps.some((s) => s.status === "failed")) return "failed";
	if (steps.some((s) => s.status === "needs_human")) return "needs_human";

	if (steps.some((s) => s.status === "running")) return "running";
	if (steps.some((s) => s.status === "review_ready")) return "ready_for_apply";

	// Only pending/applied steps remain and none is non-clean, so launching is not blocked: a
	// launchable pending step keeps the plan running; a pending step with no path to launch is
	// stuck and needs a human (unreachable in an acyclic chain, but reported rather than spun).
	return selectNextStep(plan) ? "running" : "needs_human";
}
