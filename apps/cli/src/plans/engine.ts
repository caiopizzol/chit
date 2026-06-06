// Plan engine: the thin coordinator for a sequential plan-runner (see
// docs/sequential-plan-runner-design.md). It creates a chit-managed integration worktree,
// launches a durable background converge job per runnable step, and advances the strict
// v1 chain one step at a time. It owns NO execution -- the loop/audit/cancellation live in
// the job and loop/audit stores it references by id. Every side effect (worktrees, jobs,
// git reads) is injected as a dep, so the scheduling/reconciliation logic is unit-testable
// without touching real git or spawning workers. Modelled on batches/engine.ts.
//
// No daemon: progress happens only at explicit tool calls. startPlan launches the first
// step; advancePlan reconciles a finished step's job and launches the next runnable step;
// describePlan is READ-ONLY (never launches or mutates); cancelPlan stops active jobs.
//
// This slice adds the engine layer ONLY: no MCP tool registration, no apply/commit, no
// cleanup. The gated apply-then-commit that advances the integration tip is a later slice;
// here a dependent launches only once its dependency is recorded as APPLIED (the strict
// chain blocks on the apply gate by construction).

import type { NormalizedPlan, PlanApplyPolicy, RequiredCheck } from "@chit-run/core";
import {
	type GitRunner,
	mainRepoOfWorktree,
	type PartialWork,
	repoToplevel,
	resolveBaseSha,
	WorktreeError,
} from "../batches/worktree.ts";
import type { JobRecord, LoopJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import { derivePlanStatus, selectNextStep } from "./schedule.ts";
import type { PlanStore } from "./store.ts";
import type { Plan, PlanStatus, PlanStepRecord, PlanStepStatus } from "./types.ts";

export class PlanEngineError extends Error {}

// What launchJob receives for a step's background converge run. Carries the converge brief
// plus the step's chit-managed worktree, recorded on the JOB RECORD (not just the step
// state) so a future chit_apply / chit_cleanup resolves a plan step's diff exactly like a
// single background run or a batch task -- the same baseSha -> worktree parity. The step
// worktree is cut from baseSha (an integration-branch commit); `repo` is the durable main
// repo cleanup retires from (owns the shared .git), `callerCheckout` is chit_apply's default
// target (the checkout chit_plan_start launched from) -- DISTINCT when launched from a linked
// worktree, equal for a main-repo launch.
export interface LaunchPlanJobParams {
	cwd: string; // the step's worktree
	scope: string;
	task: string; // the step body (the converge implementer's brief)
	loopId: string;
	manifestPath?: string;
	maxIterations: number;
	// The step's chit-executed verification commands; launchJob resolves them against the
	// manifest's checks at the snapshot boundary.
	requiredChecks?: RequiredCheck[];
	// The step's per-call timeout override (ms), forwarded to the converge job.
	callTimeoutMs?: number;
	worktree: {
		worktreePath: string;
		branch: string;
		baseSha: string;
		repo: string;
		callerCheckout: string;
	};
}

// Everything the engine touches that has a side effect or reads external state, injected so
// tests can drive it deterministically. Modelled on BatchEngineDeps.
export interface PlanEngineDeps {
	git: GitRunner; // read-only repo queries (toplevel, base sha resolution)
	// Create the plan's integration worktree + branch off baseSha (the plan's accumulating
	// result, living in its own managed worktree, never the operator's checkout). Throws
	// WorktreeError on failure.
	createIntegrationWorktree: (
		repo: string,
		planId: string,
		baseSha: string,
	) => { worktreePath: string; branch: string };
	// Create a step's isolated worktree + branch off baseSha (the integration-branch commit
	// the step is cut from). Injected separately from `git` so the fs-touching step is faked
	// in tests. Throws WorktreeError on failure.
	createStepWorktree: (
		repo: string,
		planId: string,
		stepId: string,
		baseSha: string,
	) => { worktreePath: string; branch: string };
	// Launch a background converge job in the step's worktree; returns its ids.
	launchJob: (p: LaunchPlanJobParams) => { jobId: string; loopId: string };
	// Read a durable job record (real: JobStore.get).
	getJob: (runId: string) => JobRecord | undefined;
	// Request cancellation of a job (real: the chit_cancel path).
	cancelJob: (runId: string) => void;
	// Whether a running job's worker is gone/silent (real: isStale(job, now)).
	isStale: (job: JobRecord) => boolean;
	// The latest loop iteration's changed files / workspace warnings for a step's worktree
	// (real: read the loop log). Empty when no iteration ran. partialWork (a failed step's
	// uncommitted state) is optional: this slice does not surface it on the record yet, but
	// the shape leaves room for a later salvage slice to do so without a dep change.
	loopDetail: (
		worktreePath: string,
		loopId: string,
	) => {
		changedFiles: string[];
		workspaceWarnings: string[];
		partialWork?: PartialWork;
	};
	now: () => number; // epoch ms
}

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_APPLY_POLICY: PlanApplyPolicy = "gated";

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export interface StartPlanOptions {
	id: string; // generated by the caller (uuid) or the plan's own id
	cwd: string; // any path in the target repo
	normalizedPlan: NormalizedPlan;
	baseBranch?: string; // override the plan's baseBranch; default: the launcher's HEAD
	maxIterations?: number; // per-step default when a step declares none
}

// Create the plan, its integration worktree, persist the record, and launch the first
// strict-chain step. Splits the durable cleanup anchor from the launching checkout exactly
// like startBatch.
export function startPlan(store: PlanStore, deps: PlanEngineDeps, opts: StartPlanOptions): Plan {
	// Split the durable cleanup anchor from the launching checkout, mirroring startBatch and the
	// single-run prepareRunWorkspace. `repo` is the main repo that owns the shared .git (survives
	// the launching linked worktree being removed before cleanup); `callerCheckout` is the checkout
	// the plan was launched from (chit_apply's default target).
	const repo = mainRepoOfWorktree(deps.git, opts.cwd);
	const callerCheckout = repoToplevel(deps.git, opts.cwd);
	const baseBranch = opts.baseBranch ?? opts.normalizedPlan.baseBranch ?? "HEAD";
	// baseSha resolves against the LAUNCHING checkout, never the main repo: the default HEAD must
	// be the launcher's HEAD, so a feature-branch launch from a linked worktree cuts the integration
	// branch off that feature's tip -- not the main repo's HEAD (which would silently base the plan
	// off the wrong commit).
	const baseSha = resolveBaseSha(deps.git, callerCheckout, baseBranch);
	const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	// The integration branch is cut at plan start; failing here aborts the start (no plan record is
	// written yet), since a plan with no integration branch can run nothing.
	const { worktreePath: integrationWorktree, branch: integrationBranch } =
		deps.createIntegrationWorktree(repo, opts.id, baseSha);

	const now = iso(deps.now());
	const steps: PlanStepRecord[] = opts.normalizedPlan.steps.map((s) => {
		const step: PlanStepRecord = {
			id: s.id,
			title: s.title,
			body: s.body,
			dependsOn: s.dependsOn,
			status: "pending",
		};
		if (s.requiredChecks !== undefined) step.requiredChecks = s.requiredChecks;
		if (s.manifestPath !== undefined) step.manifestPath = s.manifestPath;
		if (s.maxIterations !== undefined) step.maxIterations = s.maxIterations;
		if (s.callTimeoutMs !== undefined) step.callTimeoutMs = s.callTimeoutMs;
		return step;
	});

	const plan: Plan = {
		schema: 1,
		id: opts.id,
		repo,
		callerCheckout,
		// Key the DURABLE main repo, not the launching checkout: PlanStore namespaces its path by
		// the same repo anchor, and recovery must survive a linked launching worktree being removed.
		// Hashing opts.cwd would diverge from the store's namespace for a linked-worktree launch.
		repoKey: repoKey(repo),
		title: opts.normalizedPlan.title,
		apply: opts.normalizedPlan.apply ?? DEFAULT_APPLY_POLICY,
		cleanup: opts.normalizedPlan.cleanup,
		baseBranch,
		baseSha,
		integrationBranch,
		integrationWorktree,
		// The tip starts at the plan base; a later apply-then-commit slice advances it one commit
		// per applied step. A step is cut from this tip (the integration commit holding every
		// already-applied dependency).
		integrationTipSha: baseSha,
		steps,
		status: "running",
		createdAt: now,
		updatedAt: now,
	};
	store.create(plan);

	// Launch the first runnable step, then persist the resulting state. After the record exists we
	// never throw on a step launch failure: launchNextStep fails only that step (recording any
	// worktree fields for future cleanup) and the plan settles via derivePlanStatus.
	return store.update(opts.id, (c) => launchNextStep(c, deps, maxIterations));
}

// Reconcile the running step's job into step state, then launch the next runnable step. The
// only progression trigger besides start. Returns the updated plan.
export function advancePlan(
	store: PlanStore,
	deps: PlanEngineDeps,
	planId: string,
	maxIterations = DEFAULT_MAX_ITERATIONS,
): Plan {
	const existing = store.get(planId);
	if (!existing) throw new PlanEngineError(`no plan ${JSON.stringify(planId)}`);
	if (existing.status === "cancelled") return existing;
	return store.update(planId, (c) => launchNextStep(reconcile(c, deps), deps, maxIterations));
}

// Cancel every active step job and close the plan. Pending steps become cancelled; a running
// step's job is asked to cancel and the step is marked cancelled (its job settles cleanly in
// the background). Worktrees are KEPT for inspection (cleanup is a separate, explicit step).
export function cancelPlan(store: PlanStore, deps: PlanEngineDeps, planId: string): Plan {
	const existing = store.get(planId);
	if (!existing) throw new PlanEngineError(`no plan ${JSON.stringify(planId)}`);
	return store.update(planId, (c) => {
		for (const step of c.steps) {
			if (step.status === "running" && step.runId) {
				try {
					deps.cancelJob(step.runId);
				} catch {
					// best effort; the persisted intent (step cancelled) still stands
				}
				step.status = "cancelled";
			} else if (step.status === "pending") {
				step.status = "cancelled";
			}
		}
		c.status = "cancelled";
		c.updatedAt = iso(deps.now());
		return c;
	});
}

// --- internal: reconcile + launch (pure over the plan + deps) ----------

// Fold the running step's current job state into its step status. A job that reached a
// terminal state (or whose worker is stale) settles the step. v1 runs one step at a time, but
// this loops over all running steps so it is correct if more than one is ever in flight.
function reconcile(c: Plan, deps: PlanEngineDeps): Plan {
	for (const step of c.steps) {
		if (step.status !== "running" || !step.runId) continue;
		const job = deps.getJob(step.runId);
		if (!job) {
			// The job record vanished; treat as failed so the plan does not hang.
			settleStep(step, "failed", deps, { failure: "job record not found" });
			continue;
		}
		if (job.policy !== "loop") {
			// A plan step always launches a loop (converge) run, so a non-loop job here is an
			// invariant violation, not a real outcome. Settle it failed rather than misreport
			// convergence fields a one-shot run does not have.
			settleStep(step, "failed", deps, { failure: "plan step job is not a loop run" });
			continue;
		}
		// `job` is a LoopJobRecord from here. A queued OR running job is still in flight: leave the
		// step running UNLESS the worker is gone/silent (isStale covers both a queued worker that
		// never started and a running worker that went dark). A just-launched queued job is NOT a
		// failure, so an immediate advance after start must not settle it.
		const inFlight = job.state === "queued" || job.state === "running";
		if (inFlight) {
			if (deps.isStale(job)) {
				settleStep(step, "failed", deps, { job, failure: "worker appears dead (stale job)" });
			}
			continue; // still working (or just settled stale)
		}
		// Terminal job states. converged is the only clean outcome (review_ready, the gated-apply
		// gate). A COMPLETED-but-not-converged run -- the reviewer blocked, approved-but-unverified,
		// or ran out of iterations -- is a review judgment, NOT an execution failure: settle
		// needs_human so a human decides (fix / rerun / abort) without it reading as a broken run,
		// and without satisfying any dependent (only an APPLIED step does). Only a genuinely failed
		// run settles failed.
		if (job.state === "completed") {
			settleStep(step, job.stopStatus === "converged" ? "review_ready" : "needs_human", deps, {
				job,
			});
		} else if (job.state === "cancelled") {
			settleStep(step, "cancelled", deps, { job });
		} else {
			settleStep(step, "failed", deps, {
				job,
				failure: job.failure ?? `run failed (${job.stopStatus ?? "failed"})`,
			});
		}
	}
	return c;
}

// True when a running step's job would settle on the next advance: it reached a terminal
// state, or its worker is gone/silent (stale). Shared by reconcile's intent and describe's
// nextAction so status and advance agree.
function jobIsSettleable(job: JobRecord, deps: PlanEngineDeps): boolean {
	if (job.state === "queued" || job.state === "running") return deps.isStale(job);
	return true; // completed / cancelled / failed
}

function settleStep(
	step: PlanStepRecord,
	status: Extract<PlanStepStatus, "review_ready" | "needs_human" | "failed" | "cancelled">,
	deps: PlanEngineDeps,
	extra: { job?: LoopJobRecord; failure?: string },
): void {
	step.status = status;
	// Loop detail comes from an actual loop job's loop log (keyed by its loopId). With no loop job
	// in hand (the record vanished, or a non-loop job was rejected upstream), there is none to read.
	const detail =
		step.worktreePath && extra.job
			? deps.loopDetail(step.worktreePath, extra.job.loopId)
			: undefined;
	if (detail) {
		step.changedFiles = detail.changedFiles;
		step.workspaceWarnings = detail.workspaceWarnings;
	}
	if (extra.job) {
		step.auditRefs = extra.job.auditRefs;
		if (extra.job.stopStatus !== undefined) step.stopStatus = extra.job.stopStatus;
		if (extra.job.lastVerdict !== undefined) step.lastVerdict = extra.job.lastVerdict;
		if (extra.job.lastVerification !== undefined)
			step.lastVerification = extra.job.lastVerification;
		if (extra.job.lastVerificationSource !== undefined)
			step.lastVerificationSource = extra.job.lastVerificationSource;
	}
	if (status === "failed" && extra.failure !== undefined) step.error = extra.failure;
}

// Launch the single next runnable step (selectNextStep enforces the v1 strict chain: one step
// at a time, and a dependent waits for its dependency to be APPLIED). Records the worktree +
// branch BEFORE launching the job, so a launchJob failure still leaves the worktree referenced
// for cleanup. Mutates and re-derives the plan status.
function launchNextStep(c: Plan, deps: PlanEngineDeps, defaultMaxIterations: number): Plan {
	if (c.status === "cancelled") return c;
	const next = selectNextStep(c);
	if (next) {
		// A step is cut from the integration branch's current tip (the commit holding every
		// already-applied dependency). The tip is set at start and advances one commit per applied
		// step in a later slice; fall back to baseSha defensively.
		const base = c.integrationTipSha ?? c.baseSha;
		try {
			const { worktreePath, branch } = deps.createStepWorktree(c.repo, c.id, next.id, base);
			next.worktreePath = worktreePath;
			next.branch = branch;
			next.baseSha = base;
			// Globally-unique loop id: the worker's loop LOCK is global by loop id, so a bare step id
			// like "schema" would collide with the same step id in another plan. The plan id namespaces it.
			const loopId = `${c.id}-${next.id}`;
			const stepMaxIterations = next.maxIterations ?? defaultMaxIterations;
			const { jobId } = deps.launchJob({
				cwd: worktreePath,
				scope: `plan-${c.id}-${next.id}`,
				task: next.body,
				loopId,
				maxIterations: stepMaxIterations,
				// Record the managed worktree on the job record so chit_apply can reconstruct and land
				// this step's diff (baseSha -> worktree) and default its target to where the plan was
				// launched. callerCheckout is always set on the plan record (no pre-split fallback needed).
				worktree: {
					worktreePath,
					branch,
					baseSha: base,
					repo: c.repo,
					callerCheckout: c.callerCheckout,
				},
				...(next.manifestPath !== undefined && { manifestPath: next.manifestPath }),
				...(next.requiredChecks !== undefined && { requiredChecks: next.requiredChecks }),
				...(next.callTimeoutMs !== undefined && { callTimeoutMs: next.callTimeoutMs }),
			});
			next.runId = jobId;
			next.status = "running";
		} catch (e) {
			// A worktree or launch failure fails just this step; the plan settles via
			// derivePlanStatus. worktreePath/branch (if created) stay recorded so cleanup can retire it.
			next.status = "failed";
			next.error = e instanceof WorktreeError ? e.message : (e as Error).message;
		}
	}
	c.status = derivePlanStatus(c);
	c.updatedAt = iso(deps.now());
	return c;
}

// --- read-only describe (the join; NEVER launches or mutates) --------------

export interface PlanStepView {
	id: string;
	title: string;
	status: PlanStepStatus;
	dependsOn: string[];
	branch?: string;
	worktreePath?: string;
	run_id?: string; // the durable background run advancing this step (run_id == its job id)
	baseSha?: string; // the integration commit this step's worktree was cut from
	appliedCommitSha?: string; // the integration commit the gated apply produced (a later slice)
	// Live run state for a running step, or the recorded outcome for a terminal one.
	runState?: JobRecord["state"] | "stale";
	phase?: JobRecord["phase"];
	stopStatus?: PlanStepRecord["stopStatus"];
	lastVerdict?: PlanStepRecord["lastVerdict"];
	lastVerification?: PlanStepRecord["lastVerification"];
	lastVerificationSource?: PlanStepRecord["lastVerificationSource"];
	changedFiles?: string[];
	workspaceWarnings?: string[];
	auditRefs?: string[];
	error?: string;
}

export interface PlanView {
	plan_id: string;
	title: string;
	repo: string;
	callerCheckout: string;
	baseBranch: string;
	baseSha: string;
	integrationBranch: string;
	integrationWorktree?: string;
	integrationTipSha?: string;
	status: PlanStatus;
	steps: PlanStepView[];
	nextAction: string;
	createdAt: string;
	updatedAt: string;
}

// Does the plan have a running step whose job would settle on the next advance (terminal or
// stale)? A vanished job record is reconcilable too (reconcile settles it failed). Shared by
// describePlan's nextAction so status and advance agree on "is there reconcilable work."
function anyReconcilable(c: Plan, deps: PlanEngineDeps): boolean {
	return c.steps.some((s) => {
		if (s.status !== "running" || !s.runId) return false;
		const job = deps.getJob(s.runId);
		return job === undefined || jobIsSettleable(job, deps);
	});
}

// Read-only join of plan state + live job state. Joins the running step's live job state/phase
// without mutating; launches NOTHING. Inspection is safe.
export function describePlan(c: Plan, deps: PlanEngineDeps): PlanView {
	const steps: PlanStepView[] = c.steps.map((s) => {
		const view: PlanStepView = {
			id: s.id,
			title: s.title,
			status: s.status,
			dependsOn: s.dependsOn,
			...(s.branch !== undefined && { branch: s.branch }),
			...(s.worktreePath !== undefined && { worktreePath: s.worktreePath }),
			...(s.runId !== undefined && { run_id: s.runId }),
			...(s.baseSha !== undefined && { baseSha: s.baseSha }),
			...(s.appliedCommitSha !== undefined && { appliedCommitSha: s.appliedCommitSha }),
		};
		if (s.status === "running" && s.runId) {
			const job = deps.getJob(s.runId);
			if (job) {
				// A queued OR running job whose worker is gone/silent describes as stale, matching
				// reconcile + jobIsSettleable (both treat a stale queued job as reconcilable/failed). If
				// describe only flagged a stale RUNNING job, a stale queued step would read "queued" while
				// nextAction says it is reconcilable -- a contradiction.
				const inFlight = job.state === "queued" || job.state === "running";
				view.runState = inFlight && deps.isStale(job) ? "stale" : job.state;
				if (job.phase !== undefined) view.phase = job.phase;
				// Surface the live cached signal from the most recent completed iteration, so a mid-loop
				// step shows its verdict + verification instead of a blank until reconcile records the
				// final values. A plan step is always a loop job; narrow for the loop-only cached fields.
				if (job.policy === "loop") {
					if (job.lastVerdict !== undefined) view.lastVerdict = job.lastVerdict;
					if (job.lastVerification !== undefined) view.lastVerification = job.lastVerification;
					if (job.lastVerificationSource !== undefined)
						view.lastVerificationSource = job.lastVerificationSource;
				}
			}
		}
		// Recorded outcome fields (set when the step settled). For a terminal step these are the
		// source of truth; for a running step they fill in any value reconcile already cached.
		if (s.stopStatus !== undefined) view.stopStatus = s.stopStatus;
		if (s.lastVerdict !== undefined) view.lastVerdict = s.lastVerdict;
		if (s.lastVerification !== undefined) view.lastVerification = s.lastVerification;
		if (s.lastVerificationSource !== undefined)
			view.lastVerificationSource = s.lastVerificationSource;
		if (s.changedFiles !== undefined) view.changedFiles = s.changedFiles;
		if (s.workspaceWarnings !== undefined) view.workspaceWarnings = s.workspaceWarnings;
		if (s.auditRefs !== undefined) view.auditRefs = s.auditRefs;
		if (s.error !== undefined) view.error = s.error;
		return view;
	});

	return {
		plan_id: c.id,
		title: c.title,
		repo: c.repo,
		callerCheckout: c.callerCheckout,
		baseBranch: c.baseBranch,
		baseSha: c.baseSha,
		integrationBranch: c.integrationBranch,
		...(c.integrationWorktree !== undefined && { integrationWorktree: c.integrationWorktree }),
		...(c.integrationTipSha !== undefined && { integrationTipSha: c.integrationTipSha }),
		status: c.status,
		steps,
		nextAction: planNextAction(c, deps),
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
	};
}

// The next tool call the operator should make, named explicitly (an agent follows nextAction
// literally). The forward flow always passes through the operator gate: a review_ready step
// waits for a gated apply, never advancing on its own. The gated apply-then-commit and the
// cleanup tool are a later slice, so the messages below NEVER instruct the operator to apply
// via chit_plan_advance or clean with chit_plan_cleanup -- those tools do not exist yet, and
// this text is surfaced publicly through describePlan. The apply slice restores that guidance
// when it wires the gate.
function planNextAction(c: Plan, deps: PlanEngineDeps): string {
	if (c.status === "completed") {
		return "every step is applied and committed to the integration branch; review the integration branch.";
	}
	if (c.status === "cancelled") {
		return "plan cancelled (running jobs settle in the background; worktrees are kept for inspection). Review what landed in the step worktrees (changedFiles).";
	}
	if (c.status === "failed") {
		return "a step failed during execution (a dead worker, a worktree error, or a thrown run -- see the step's status/error); inspect its worktree (changedFiles may be empty if it broke mid-review) and receipt, then fix and rerun the step or abort the plan.";
	}
	if (c.status === "needs_human") {
		return "a step paused for a human decision: its run completed but did not converge clean (the reviewer blocked, approved-but-unverified, or ran out of iterations). Inspect its worktree (changedFiles) and receipt, then fix and rerun, raise the budget and rerun, or abort.";
	}
	if (c.status === "ready_for_apply") {
		return "a step is review_ready: its run converged and its diff sits uncommitted in its worktree (changedFiles lists them; nothing is committed yet). Inspect it with chit_plan_status; the gated apply that flows it into the integration branch and unblocks the next step is a later step and is not wired yet.";
	}
	// running
	if (anyReconcilable(c, deps)) {
		return "a step's run finished; call chit_plan_advance to reconcile it and launch the next step.";
	}
	if (selectNextStep(c)) {
		return "call chit_plan_advance to launch the next step.";
	}
	return "a step is in flight; watch with chit_plan_status (read-only, never launches), then call chit_plan_advance once it reports a finished job (chit_plan_cancel to stop).";
}

// --- list (recover plan ids; compact, read-only) --------------------------

// A one-line summary per plan for the list view, so an operator who lost a plan id can find
// it again without reading state files. Counts come straight off the stored step statuses (no
// job reads), so this is cheap.
export interface PlanSummary {
	plan_id: string;
	title: string;
	status: PlanStatus;
	stepCount: number;
	applied: number;
	reviewReady: number;
	needsHuman: number;
	failed: number;
	createdAt: string;
	updatedAt: string;
	cleanedAt?: string;
}

export function summarizePlan(c: Plan): PlanSummary {
	const summary: PlanSummary = {
		plan_id: c.id,
		title: c.title,
		status: c.status,
		stepCount: c.steps.length,
		applied: c.steps.filter((s) => s.status === "applied").length,
		reviewReady: c.steps.filter((s) => s.status === "review_ready").length,
		needsHuman: c.steps.filter((s) => s.status === "needs_human").length,
		failed: c.steps.filter((s) => s.status === "failed").length,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
	};
	if (c.cleanedAt !== undefined) summary.cleanedAt = c.cleanedAt;
	return summary;
}

// All plans for the repo, newest-created first, capped by `limit` when given. Read-only over
// the store (PlanStore.list already skips corrupt files).
export function listPlans(store: PlanStore, limit?: number): PlanSummary[] {
	const all = store.list().map(summarizePlan);
	return limit !== undefined ? all.slice(0, limit) : all;
}
