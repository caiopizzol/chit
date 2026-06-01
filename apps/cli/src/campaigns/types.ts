import type { LoopStopStatus, LoopVerdict } from "@chit-run/core";

// Campaign model: a thin coordinator over durable background converge jobs. A
// campaign plans a static graph of tasks, creates one git worktree per task, and
// launches a `chit_converge_run` job per runnable task. It owns NO execution: the
// loop, audit, and cancellation all live in the job/loop/audit stores it
// references by id. State is durable under the state dir (keyed by repo), never
// in the reviewed tree.
//
// v1 is deliberately narrow: an explicit, reviewed task list (no GitHub coupling),
// no auto-merge (the campaign stops at reviewable artifacts), no daemon (progress
// is driven by the explicit chit_campaign_advance tool, never by a status read).

// Campaign lifecycle, derived from its tasks (see schedule.deriveCampaignStatus):
//   planning  - created, nothing launched yet (transient)
//   running   - at least one task active or startable
//   needs_human - stuck: pending/blocked tasks with no active work and no failure
//   ready_for_review - every task reached a terminal reviewable/failed/cancelled
//     state and at least one is review_ready
//   failed    - a task failed and nothing else can progress
//   cancelled - the campaign was cancelled
export type CampaignStatus =
	| "planning"
	| "running"
	| "needs_human"
	| "ready_for_review"
	| "failed"
	| "cancelled";

// Task lifecycle. Simplified from the prototype: merge semantics are deliberately
// absent (merging is the human's, outside the campaign). A task that converged is
// `review_ready`, NOT merged.
//   pending      - not yet launched
//   running      - a background job is advancing it
//   review_ready - its job converged; the worktree diff is ready for human review
//   failed       - its job failed/blocked, or the worktree could not be created
//   cancelled    - cancelled before or during the run
export type TaskStatus = "pending" | "running" | "review_ready" | "failed" | "cancelled";

// A task is "active" (occupies a parallel slot) only while running.
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running"]);

// A dependency is satisfied once the upstream task is reviewable. We do NOT wait
// for merge (there is none); a dependent may proceed against the upstream's
// reviewed branch. review_ready is the only satisfying state.
export const DEPENDENCY_SATISFIED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"review_ready",
]);

// The terminal outcome of a task's job, summarized from the loop log + job record
// (the campaign never recomputes execution; it points). Present once the task is
// review_ready or failed.
export interface TaskResult {
	// Mirrors the job's stop status exactly (the campaign points, never recomputes).
	stopStatus?: LoopStopStatus;
	lastVerdict?: LoopVerdict;
	iterations: number;
	changedFiles: string[];
	workspaceWarnings: string[];
	auditRefs: string[];
}

export interface CampaignTask {
	id: string; // caller-supplied, unique within the campaign; a safe slug
	title: string;
	body: string; // the task brief handed to the converge implementer
	status: TaskStatus;
	dependencies: string[]; // task ids that must be review_ready first
	// Paths this task expects to touch (globs: `dir/**`, `dir/`, or a file). Two
	// tasks with overlapping claims are never run concurrently (the scheduler
	// serializes them). Required: empty is allowed ONLY with allowPathOverlap.
	claimedPaths: string[];
	// Opt-in to running with no/again-overlapping path claims. An empty claimedPaths
	// is rejected at start unless this is set; when set, the task is treated as
	// overlapping everything (it runs alone, never concurrent with another task).
	allowPathOverlap?: boolean;
	// Per-task converge manifest override (absolute). Resolution order:
	// task.manifestPath -> campaign.manifestPath -> the bundled default converge
	// manifest. This is the ONLY per-task model knob (no arbitrary agent config).
	manifestPath?: string;
	// Filled in once the worktree is created and the job is launched.
	worktreePath?: string; // absolute, recorded so nothing recomputes it
	branch?: string;
	jobId?: string; // the durable background job advancing this task
	result?: TaskResult;
	error?: string; // set when status === "failed"
}

export interface Campaign {
	schema: 1;
	id: string;
	repo: string; // absolute path to the repo root (git top-level) the campaign runs against
	repoKey: string; // hash of repo, the state-dir namespace
	baseBranch: string; // the ref task branches/worktrees are created from
	baseSha: string; // resolved at start, so every task worktree shares one base
	maxParallel: number;
	// Campaign-level default converge manifest (absolute), applied to any task
	// without its own manifestPath. Undefined -> the bundled default.
	manifestPath?: string;
	status: CampaignStatus;
	tasks: CampaignTask[];
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
}

// Conservative cap on concurrent tasks for v1: parallel converge jobs each spawn
// two agents, so the fan-out multiplies fast. The MCP tool clamps to this.
export const MAX_PARALLEL_CAP = 4;
