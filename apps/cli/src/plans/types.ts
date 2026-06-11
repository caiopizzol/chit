import type {
	AuditParticipantSnapshot,
	LoopReceipt,
	LoopStopStatus,
	LoopVerdict,
	ManifestBinding,
	PlanApplyPolicy,
	PlanApprovalRecipe,
	PlanCleanupPolicy,
	PlanHandoff,
	PlanHandoffFormat,
	RequiredCheck,
	Verification,
	VerificationSource,
} from "@chit-run/core";

// One declared handoff captured (or attempted) when its producing step settled after converging
// (see docs/structured-plan-handoffs-design.md, Phase 2). status:
//   captured - the file existed, was a regular file within the worktree, within its byte cap, and
//              (for json) parsed; digest + body are recorded.
//   missing  - no file at the declared path.
//   invalid  - present but failed a trust-boundary or shape check (escaped the worktree, was a
//              symlink or non-regular file, exceeded the byte cap, or was unparseable JSON).
// Every declared handoff is required in v1, so a missing/invalid one keeps the step from a clean
// review_ready (the engine pauses it needs_human).
export type PendingHandoffStatus = "captured" | "missing" | "invalid";

export interface PendingHandoff {
	id: string;
	path: string; // the declared relative path, echoed for receipts
	format: PlanHandoffFormat;
	status: PendingHandoffStatus;
	bytes?: number; // on-disk byte count, present whenever the file was read
	digest?: string; // "sha256:<hex>", present ONLY when status === "captured"
	error?: string; // present when status !== "captured"
	preview?: string; // bounded text preview, present whenever the file was read
	// The full captured content, recorded durably for the later apply gate (Phase 3) where the
	// operator inspects the exact body being accepted into downstream prompts. DELIBERATELY kept out
	// of the compact status projection (PendingHandoffView) -- default status shows only the preview.
	body?: string;
	capturedAt: string; // ISO 8601
}

// The compact, body-free projection of a PendingHandoff for status/describe surfaces.
export interface PendingHandoffView {
	id: string;
	path: string;
	format: PlanHandoffFormat;
	status: PendingHandoffStatus;
	bytes?: number;
	digest?: string;
	error?: string;
	preview?: string;
}

// Plan model: the durable record a sequential plan-runner drives (see
// docs/sequential-plan-runner-design.md). A plan is the missing layer between a single
// converge run and a parallel batch: an operator-authored, reviewed chain of steps where
// each step's worktree is cut from a base that already contains the prior step's APPLIED
// diff, with the operator gating every forward flow.
//
// Like the batch and job records, the plan record is a thin pointer: it owns no execution.
// Each step is run by the existing converge machinery; the plan record only records what
// runs, what base it was cut from, and the gated-apply outcomes. State is durable under the
// state dir (keyed by repo), never in the reviewed tree.
//
// Slice B (this module) lands the record, store, and pure sequencing/status helpers ONLY.
// It adds no MCP tool, no worker, no worktree creation, and no apply/commit behavior. The
// execution slices populate the optional future handles described below.

// Plan lifecycle, derived from its steps (see schedule.derivePlanStatus):
//   running         - a step's background run is advancing, OR a step can launch next
//   ready_for_apply - a terminal, clean step is waiting on the operator's gated apply
//   needs_human     - a step paused for a human decision (ran out of iterations, reviewer
//                     blocked, or a pending step whose dependency can never be applied)
//   completed       - every step's diff is applied to the integration branch
//   failed          - a step's run broke and the plan cannot progress
//   cancelled       - the plan was cancelled
export type PlanStatus =
	| "running"
	| "ready_for_apply"
	| "needs_human"
	| "completed"
	| "failed"
	| "cancelled";

// Per-step lifecycle. Kept small and aligned with the design sections 4-5; deliberately NO
// merge/auto-apply vocabulary (forward flow is always an operator-confirmed apply).
//   pending      - declared but not yet launched
//   running      - a background converge run is advancing it
//   review_ready - its run converged + verified; the worktree diff is ready for the
//                  operator's gated apply. Does NOT satisfy a dependent: a code dependency
//                  is only satisfied once the upstream step is APPLIED to the integration
//                  branch (the inverse of a batch dependency, which never merges a diff).
//   applied      - its diff was applied AND committed to the integration branch; the tip
//                  advanced. This is the only state that satisfies a dependent.
//   needs_human  - its run COMPLETED but did not converge clean (reviewer blocked,
//                  approved-but-unverified, or ran out of iterations). A review judgment;
//                  the plan pauses here. The operator decides: fix and rerun, raise the
//                  budget and rerun, or abort.
//   failed       - orchestration/execution broke (worker died, run threw, worktree error),
//                  not a review judgment. The plan pauses here.
//   cancelled    - cancelled before or during the run
export type PlanStepStatus =
	| "pending"
	| "running"
	| "review_ready"
	| "applied"
	| "needs_human"
	| "failed"
	| "cancelled";

// A code dependency is satisfied only once the upstream step is APPLIED to the integration
// branch (and committed, so the tip has advanced). review_ready is NOT enough: a batch
// dependency does not merge a diff, so a step cut from a merely-reviewed upstream would
// start blind to its code. This single-element set is the whole reason the plan-runner
// exists, kept explicit so a future change is deliberate.
export const DEPENDENCY_APPLIED_STATUSES: ReadonlySet<PlanStepStatus> = new Set<PlanStepStatus>([
	"applied",
]);

// Statuses that mean a step is in flight or paused. In the v1 strict chain, ANY step in one
// of these blocks launching the next step (the plan never skips ahead past a step that is
// running, awaiting the apply gate, or paused for a human). Waves (slice 3) will relax this
// to per-dependent blocking; v1 is conservatively plan-wide.
export const BLOCKS_LAUNCH_STATUSES: ReadonlySet<PlanStepStatus> = new Set<PlanStepStatus>([
	"running",
	"review_ready",
	"needs_human",
	"failed",
	"cancelled",
]);

// One step's durable record. The parsed step fields are frozen from the normalized plan at
// plan start (the runtime never re-reads the plan file); the remaining fields are filled in
// as the step progresses. dependsOn names other step ids and means a CODE dependency: every
// named step must be APPLIED before this step launches.
export interface PlanStepRecord {
	id: string;
	title: string;
	body: string; // the brief handed to the converge implementer
	dependsOn: string[];
	// The reviewed commit subject the gated apply uses on the integration branch (bound by
	// the plan approval hash). Absent -> the fallback `plan step <id>: <title>`.
	commitMessage?: string;
	requiredChecks?: RequiredCheck[];
	// The config recipe id the step selected (when it did). The recipe's resolved
	// identity + defaults live on the plan record's `recipes`; its resolved manifest
	// reference is recorded as this step's manifestPath at plan start, so launch,
	// re-verification, and receipts read one manifest reference shape for recipe-backed
	// and direct-manifest steps alike.
	recipe?: string;
	manifestPath?: string;
	maxIterations?: number;
	callTimeoutMs?: number;

	status: PlanStepStatus;

	// Future handles, populated by the execution slices. Recorded here (never recomputed) so
	// closed-session recovery resolves a step's run, base, and apply outcome from the plan
	// record alone.
	runId?: string; // the durable background converge run advancing this step
	baseSha?: string; // the integration-branch commit this step's worktree was cut from
	appliedCommitSha?: string; // the integration commit the gated apply produced (advances the tip)
	worktreePath?: string; // absolute, recorded so nothing recomputes it
	branch?: string;
	// Run outcome summarized from the loop log + job record (the plan points, never
	// recomputes), recorded when the step settles so a status receipt and closed-session
	// recovery resolve it from the plan record alone. Mirrors the batch TaskResult fields.
	changedFiles?: string[];
	workspaceWarnings?: string[];
	auditRefs?: string[];
	stopStatus?: LoopStopStatus;
	lastVerdict?: LoopVerdict;
	// The latest iteration's verification + source (chit-executed vs reviewer), mirrored from
	// the job. Authoritative over lastVerdict when source is "chit".
	lastVerification?: Verification;
	lastVerificationSource?: VerificationSource;
	// Execution provenance, snapshotted from the loop job at settle so a TERMINAL step row keeps
	// showing which agent/adapter/session/permissions/config ran -- the live job join is gone once
	// the step leaves running. Redacted shape (envKeys, not env values). Absent on a legacy job.
	participants?: Record<string, AuditParticipantSnapshot>;
	// The compact loop receipt (the same safe shape v0.38 surfaces on single-run views),
	// snapshotted from the step's loop log when it settles so a terminal row answers "what
	// happened?" from the plan record alone. Carries no participants, env values, prompts,
	// outputs, or blob bodies -- that provenance lives in participants above, not here. Absent
	// on a running step (no receipt before it settles) and on a legacy record.
	receipt?: LoopReceipt;
	// Set when status === "failed", and when a launch-time manifest-binding drift
	// paused the step as "needs_human" (the reason names the drift), and when producer handoff
	// capture failed at settle (the reason names the unmet handoff contract).
	error?: string;
	// The handoff declarations frozen from the normalized plan at plan start (the runtime never
	// re-reads the plan file), keyed by handoff id. Drives producer capture at settle and the
	// task-brief handoff contract at launch. Absent when the step declares no handoffs.
	handoffs?: Record<string, PlanHandoff>;
	// Pending captured handoffs, recorded when the step settles after converging (Phase 2 producer
	// capture), keyed by handoff id. A failed capture also pauses the step needs_human. Absent on a
	// step that declares none and on a record that settled before capture existed.
	pendingHandoffs?: Record<string, PendingHandoff>;
}

export interface Plan {
	schema: 1;
	id: string;
	// The DURABLE main repo that owns the shared .git (resolved via mainRepoOfWorktree), NOT
	// the launching checkout. When chit_plan_start runs from a linked worktree, the launching
	// checkout is that linked worktree -- which the operator may remove (e.g. /worktree-cleanup
	// once the feature merges) BEFORE cleaning the plan. Cleanup runs `git worktree remove` from
	// here, so it must anchor on the main repo or git cannot even start in the deleted checkout
	// and every managed worktree is stranded. This mirrors the batch linked-worktree lesson
	// (investigation-batch-recovery-0.32, scenario 5).
	repo: string;
	// The launching checkout chit_plan_start ran from (repoToplevel): a linked worktree, or the
	// main repo itself. DISTINCT from `repo` for a linked-worktree launch; EQUAL to repo for a
	// main-repo launch. Kept apart so an apply defaults its target where the operator is working
	// while cleanup still anchors on `repo`.
	callerCheckout: string;
	repoKey: string; // hash of repo, the state-dir namespace
	// Plan metadata carried over from the normalized plan.
	title: string;
	apply: PlanApplyPolicy; // v1: always "gated"
	cleanup: PlanCleanupPolicy;
	// The base the integration branch is cut from, resolved at plan start.
	baseBranch: string;
	baseSha: string;
	// The chit-managed integration branch: the plan's accumulating result and primary
	// reviewable artifact. Cut from baseSha at start, living in its own managed worktree (never
	// the operator's checkout). The branch name is chosen at plan start; the worktree and tip
	// are created/advanced by the execution slices, so they are optional on the record.
	integrationBranch: string;
	integrationWorktree?: string; // absolute; the managed worktree the branch lives in
	integrationTipSha?: string; // the branch tip; advances one commit per applied step
	// The APPROVED manifest binding per step that names a manifestPath (keyed by step
	// id): content digest + safe participant execution summary, exactly what the
	// approval hash bound. Each later step launch re-resolves the reference from the
	// step's own cut commit and pauses the step needs_human when it no longer matches
	// -- confirm-time verification alone is not enough for a long plan. Absent on a
	// manifest-free plan and on records that predate the binding.
	manifests?: Record<string, ManifestBinding>;
	// The APPROVED recipe identity + runtime defaults per recipe-backed step (keyed by
	// step id), exactly what the approval hash bound. The launch reads the recipe's
	// default budgets from here (a step-level override wins); the recipe's manifest
	// binding sits in `manifests` under the same step id. Absent on a recipe-free plan
	// and on records that predate recipes.
	recipes?: Record<string, PlanApprovalRecipe>;
	steps: PlanStepRecord[];
	status: PlanStatus;
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
	// Set when a cleanup retired this plan's managed worktrees + branches. The plan/run/audit
	// receipts are kept; this only records that the disposable worktree artifacts were retired.
	cleanedAt?: string; // ISO 8601
}
