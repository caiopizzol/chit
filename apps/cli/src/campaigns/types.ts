// Campaign model: the durable record of an experimental converge campaign. A
// campaign coordinates several `chit converge` runs across a small set of
// GitHub issues, one git worktree per task. See notes/campaign-v0.md.
//
// This is cli-only (not browser-safe core): Studio does not render campaigns,
// so the model and its validation live here next to the filesystem store,
// rather than in @chit/core like the loop-log model.

// Campaign-level status. `planning` after start (tasks classified, nothing run
// yet); `running` while at least one task is active or runnable; `needs_human`
// when progress is blocked on a human (a blocked task, an unclassified task, or
// a dependent task that cannot proceed); `ready_for_review` when every task has
// converged and is waiting on a human to review and merge (chit has done all it
// will do); `complete` only when every task is actually merged; `failed` when a
// task's converge run itself failed. v0 never reaches `complete` on its own
// since it does not track merges.
export type CampaignStatus =
	| "planning"
	| "running"
	| "needs_human"
	| "ready_for_review"
	| "complete"
	| "failed";

// Per-task status. The v0 lifecycle is pending -> running -> terminal:
//   review_ready  converge converged (reviewer said proceed); awaits human merge
//   blocked       converge returned block, or hit its iteration budget
//   failed        the converge run itself failed or threw
//   needs_human   the planner could not classify the task (e.g. unknown paths)
// merge_ready / merged are reserved: v0 has no merge tracking, so it never
// assigns them. The scheduler still gates dependents on them, which makes
// dependent tasks fail-safe (they do not auto-run in v0). See the design note.
export type TaskStatus =
	| "pending"
	| "running"
	| "blocked"
	| "review_ready"
	| "merge_ready"
	| "merged"
	| "failed"
	| "needs_human";

// A task is "active" (occupies a parallel slot, and its path claims block
// overlapping tasks) while running. Terminal-good states free the slot.
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["running"]);

// Dependency gate: a task may run only when every dependency has reached one of
// these. v0 never assigns these automatically, so dependent tasks wait.
export const DEPENDENCY_SATISFIED_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"merge_ready",
	"merged",
]);

// What a finished converge run left behind, recorded for status/inspect. Mirrors
// the loop log: the loop stop status, the last iteration's verdict, the change
// set, and the audit transcript ids the iterations linked to.
export interface TaskResult {
	loopStatus: "converged" | "blocked" | "max-iterations";
	finalVerdict?: "proceed" | "revise" | "block";
	iterations: number;
	changedFiles: string[];
	auditRunIds: string[];
	summary: string;
}

export interface CampaignTask {
	id: string; // e.g. "issue-3"
	issueNumber?: number;
	title: string;
	// The converge task text (issue body + acceptance criteria). May be empty.
	body: string;
	status: TaskStatus;
	// Task ids this task depends on. Must all reference tasks in the campaign.
	dependencies: string[];
	// Repo-relative path claims (literal paths or simple `dir/**` globs). Two
	// tasks may not claim overlapping paths.
	claimedPaths: string[];
	worktreePath?: string;
	branch?: string;
	loopId?: string;
	result?: TaskResult;
	error?: string;
}

export interface Campaign {
	schema: 1;
	id: string;
	repo: string; // absolute path to the main repo checkout
	baseBranch: string;
	baseSha: string;
	maxParallel: number;
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
	status: CampaignStatus;
	tasks: CampaignTask[];
}

// v0 hard cap on parallelism. The CLI also enforces this; kept here so the model
// and the scheduler agree on the ceiling.
export const MAX_PARALLEL_CAP = 2;
