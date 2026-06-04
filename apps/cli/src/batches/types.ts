import type {
	LoopStopStatus,
	LoopVerdict,
	RequiredCheck,
	Verification,
	VerificationSource,
} from "@chit-run/core";

// Batch model: a thin coordinator over durable background converge jobs. A
// batch plans a static graph of tasks, creates one git worktree per task, and
// launches a `chit_converge_run` job per runnable task. It owns NO execution: the
// loop, audit, and cancellation all live in the job/loop/audit stores it
// references by id. State is durable under the state dir (keyed by repo), never
// in the reviewed tree.
//
// v1 is deliberately narrow: an explicit, reviewed task list (no GitHub coupling),
// no auto-merge (the batch stops at reviewable artifacts), no daemon (progress
// is driven by the explicit chit_batch_advance tool, never by a status read).

// Batch lifecycle, derived from its tasks (see schedule.deriveBatchStatus):
//   planning  - created, nothing launched yet (transient)
//   running   - at least one task active or startable
//   needs_human - a human must decide: pending tasks blocked by an unfinished
//     dependency, OR a terminal task that needs attention (completed but did not
//     converge clean). Outranks ready_for_review so the batch never reads "ready"
//     while any task is unresolved.
//   ready_for_review - every task reached a terminal state, at least one is
//     review_ready, and none needs attention
//   failed    - a task failed and nothing else can progress
//   cancelled - the batch was cancelled
export type BatchStatus =
	| "planning"
	| "running"
	| "needs_human"
	| "ready_for_review"
	| "failed"
	| "cancelled";

// Task lifecycle. Simplified from the prototype: merge semantics are deliberately
// absent (merging is the human's, outside the batch). A task that converged is
// `review_ready`, NOT merged.
//   pending         - not yet launched
//   running         - a background job is advancing it
//   review_ready    - its job converged + verified; the worktree diff is ready to review
//   needs_attention - its job COMPLETED but did not converge clean (the reviewer
//                     blocked, approved-but-unverified -> needs-decision, or ran out of
//                     iterations -> max-iterations). A review judgment, NOT an execution
//                     failure: a human inspects the worktree + receipt and decides
//                     (fix / rerun / discard). Does NOT satisfy a dependent.
//   failed          - orchestration/execution broke (worker died, job vanished, the
//                     manifest run threw or returned ok:false, or the worktree could not
//                     be created), not a review judgment
//   cancelled       - cancelled before or during the run
export type TaskStatus =
	| "pending"
	| "running"
	| "review_ready"
	| "needs_attention"
	| "failed"
	| "cancelled";

// A task is "active" (occupies a parallel slot) only while running.
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running"]);

// A dependency is satisfied once the upstream task is reviewable. We do NOT wait
// for merge (there is none); a dependent may proceed against the upstream's
// reviewed branch. review_ready is the only satisfying state.
export const DEPENDENCY_SATISFIED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"review_ready",
]);

// The terminal outcome of a task's job, summarized from the loop log + job record
// (the batch never recomputes execution; it points). Present once the task is
// review_ready, needs_attention, or failed.
export interface TaskResult {
	// Mirrors the job's stop status exactly (the batch points, never recomputes).
	stopStatus?: LoopStopStatus;
	lastVerdict?: LoopVerdict;
	// The latest iteration's verification + source (chit-executed vs reviewer), mirrored
	// from the job. Authoritative over lastVerdict when source is "chit".
	lastVerification?: Verification;
	lastVerificationSource?: VerificationSource;
	iterations: number;
	changedFiles: string[];
	workspaceWarnings: string[];
	auditRefs: string[];
}

export interface BatchTask {
	id: string; // caller-supplied, unique within the batch; a safe slug
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
	// task.manifestPath -> batch.manifestPath -> the bundled default converge manifest.
	manifestPath?: string;
	// Per-task chit-executed verification commands. Precedence (closest declared wins,
	// never a merge): task -> batch -> the manifest policy's requiredChecks.
	requiredChecks?: RequiredCheck[];
	// Filled in once the worktree is created and the job is launched.
	worktreePath?: string; // absolute, recorded so nothing recomputes it
	branch?: string;
	jobId?: string; // the durable background job advancing this task
	result?: TaskResult;
	error?: string; // set when status === "failed"
}

export interface Batch {
	schema: 1;
	id: string;
	repo: string; // absolute path to the repo root (git top-level) the batch runs against
	repoKey: string; // hash of repo, the state-dir namespace
	baseBranch: string; // the ref task branches/worktrees are created from
	baseSha: string; // resolved at start, so every task worktree shares one base
	maxParallel: number;
	// Batch-level default converge manifest (absolute), applied to any task
	// without its own manifestPath. Undefined -> the bundled default.
	manifestPath?: string;
	// Batch-level chit-executed verification, applied to any task without its own
	// requiredChecks (a task's override wins; the manifest policy's are the fallback).
	requiredChecks?: RequiredCheck[];
	status: BatchStatus;
	tasks: BatchTask[];
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
	// Set when chit_batch_cleanup removed this batch's worktrees + branches.
	// The batch/job/loop/audit receipts are kept; this only records that the
	// disposable worktree artifacts were retired.
	cleanedAt?: string; // ISO 8601
}

// Conservative cap on concurrent tasks for v1: parallel converge jobs each spawn
// two agents, so the fan-out multiplies fast. The MCP tool clamps to this.
export const MAX_PARALLEL_CAP = 4;
