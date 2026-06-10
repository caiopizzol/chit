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

import { dirname } from "node:path";
import type {
	BoundParticipantSummary,
	LoopReceipt,
	ManifestBinding,
	NormalizedPlan,
	PlanApplyPolicy,
	PlanApprovalRecipe,
	RequiredCheck,
} from "@chit-run/core";
import { describeManifestBindingDrift } from "@chit-run/core";
import {
	type GitRunner,
	mainRepoOfWorktree,
	type PartialWork,
	type RemoveWorktreeResult,
	type RunApplyResult,
	repoToplevel,
	resolveBaseSha,
	WorktreeError,
} from "../batches/worktree.ts";
import type { JobRecord, LoopJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import type { ResolveManifestBinding, ResolveRecipe } from "../manifest/binding.ts";
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
	// The APPROVED manifest content digest for this step's manifestPath, forwarded so
	// the job record carries it and the worker re-verifies the bytes it actually reads.
	manifestDigest?: string;
	// The APPROVED participant execution summary for the same manifest binding. Forwarded
	// to the worker so config drift after enqueue cannot silently change the agent/model surface.
	manifestParticipants?: Record<string, BoundParticipantSummary>;
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
	// result, living in its own managed worktree, never the operator's checkout). It links NO
	// tooling: the integration worktree only applies + commits step diffs, never runs checks, and a
	// node_modules symlink there would be committed by the step commit's `git add -A`. Throws
	// WorktreeError on failure.
	createIntegrationWorktree: (
		repo: string,
		planId: string,
		baseSha: string,
	) => { worktreePath: string; branch: string };
	// Create a step's isolated worktree + branch off baseSha (the integration-branch commit
	// the step is cut from). Injected separately from `git` so the fs-touching step is faked
	// in tests. `toolingSource` is the checkout the plan was launched from; its node_modules is
	// linked into the fresh step worktree so the step's checks resolve installed binaries the
	// worktree lacks. Throws WorktreeError on failure.
	createStepWorktree: (
		repo: string,
		planId: string,
		stepId: string,
		baseSha: string,
		toolingSource: string,
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
	// the shape leaves room for a later salvage slice to do so without a dep change. receipt
	// is the compact LoopReceipt derived from the SAME loop records (the v0.38 single-run
	// shape); optional because a log that is unreadable or has no records yields none.
	loopDetail: (
		worktreePath: string,
		loopId: string,
	) => {
		changedFiles: string[];
		workspaceWarnings: string[];
		receipt?: LoopReceipt;
		partialWork?: PartialWork;
	};
	// Apply a step's worktree diff into the plan integration worktree (the gated apply), wrapping
	// the shared applyRunWorkspace primitive (real: applyRunWorkspace(realGit, ...)). Dry-run vs
	// confirm and ALL conflict/overwrite safety live in that primitive; the engine never invents
	// patch logic. Injected so tests fake or real-git verify it.
	applyWorkspace: (p: {
		worktreePath: string;
		baseSha: string;
		target: string;
		confirm: boolean;
		includeUntracked?: string[];
	}) => RunApplyResult;
	// Stage + commit the integration worktree after a clean apply, returning the new HEAD (real:
	// commitWorktree(realGit, ...)). committed=false with a sha is a coherent no-op (no diff to
	// commit); an error means the commit failed and the step must NOT be marked applied.
	commit: (
		worktreePath: string,
		message: string,
	) => {
		committed: boolean;
		sha?: string;
		error?: string;
	};
	// Retire one plan-managed worktree + branch for cleanup (real: removeTaskWorktree(realGit, ...)).
	removeWorktree: (repo: string, worktreePath: string, branch: string) => RemoveWorktreeResult;
	// Re-resolve a manifest reference's CURRENT binding (content digest + participant
	// summary) so a step launch can compare it to the approved one and pause needs_human
	// on drift. Optional: when absent, no launch-time verification runs (a record with no
	// approved bindings has nothing to verify against either). The real implementation
	// loads fresh config per call -- the same lifecycle the worker has -- so config drift
	// is made visible instead of pinned away. Throws ManifestBindingError when the
	// reference can no longer be resolved (treated as drift).
	resolveManifestBinding?: ResolveManifestBinding;
	// Resolve a step's config recipe to its effective execution surface (identity,
	// provenance, runtime defaults, and the manifest binding) at the chit_plan_start
	// gate, so the approval hash binds what the recipe RESOLVES TO, not the id string.
	// Optional for the same reason resolveManifestBinding is (test harnesses;
	// production always wires it); a recipe-naming plan is REFUSED at the gate when it
	// is absent -- silently launching without the recipe's manifest would run an
	// execution surface nobody reviewed.
	resolveRecipe?: ResolveRecipe;
	// Best-effort removal of the plan's now-empty worktree ROOT (~/worktrees/chit/<planId>) after
	// every child worktree under it is retired (real: removeEmptyDir). The plan layout nests the
	// integration worktree beside a steps/ dir, so no single removeWorktree call can drop the root --
	// cleanup removes it explicitly once empty. Empty-only: never removes a non-empty directory or
	// anything outside the plan's own root. Returns whether the directory was actually removed.
	removeEmptyDir: (dir: string) => boolean;
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
	// The APPROVED manifest bindings (keyed by step id) from the gate's dry run, persisted
	// on the plan record so every later step launch re-verifies against exactly what was
	// approved. For a recipe-backed step this is the recipe's RESOLVED binding.
	manifests?: Record<string, ManifestBinding>;
	// The APPROVED recipe identity + runtime defaults per recipe-backed step (keyed by
	// step id), persisted so launches read the approved defaults, never the live config.
	recipes?: Record<string, PlanApprovalRecipe>;
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
		if (s.commitMessage !== undefined) step.commitMessage = s.commitMessage;
		if (s.requiredChecks !== undefined) step.requiredChecks = s.requiredChecks;
		if (s.recipe !== undefined) {
			step.recipe = s.recipe;
			// A recipe-backed step records the recipe's RESOLVED manifest reference (from the
			// approved binding the gate produced) as its own manifestPath, so launch, drift
			// re-verification, and receipts read one reference shape for recipe-backed and
			// direct-manifest steps alike. The parser guarantees s.manifestPath is unset here.
			const bound = opts.manifests?.[s.id];
			if (bound !== undefined) step.manifestPath = bound.manifestPath;
		}
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
		...(opts.manifests !== undefined &&
			Object.keys(opts.manifests).length > 0 && { manifests: opts.manifests }),
		...(opts.recipes !== undefined &&
			Object.keys(opts.recipes).length > 0 && { recipes: opts.recipes }),
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

// --- gated apply: flow a review_ready step into the integration branch -----

// The commit message a step's apply produces on the integration branch: the step's reviewed
// commitMessage when the plan authored one (bound by the approval hash through the normalized
// plan, so it is never a confirm-time override), else the deterministic fallback. One commit
// per applied step; the step id + title keep the fallback history readable.
export function planStepCommitMessage(step: PlanStepRecord): string {
	return step.commitMessage ?? `plan step ${step.id}: ${step.title}`;
}

export interface PlanApplyOutcome {
	planId: string;
	stepId: string;
	confirmed: boolean; // false = dry run (nothing applied, nothing committed, plan untouched)
	// The underlying apply result (tracked files, whether it applies clean, conflict, untracked
	// candidates) from the shared primitive -- the operator's review surface.
	apply: RunApplyResult;
	// Set ONLY on a confirmed, clean apply that committed (or coherently no-op'd): the integration
	// commit the step produced (the advanced tip), or the unchanged tip when the step had no diff.
	appliedCommitSha?: string;
	integrationTipSha?: string;
	stepApplied: boolean; // the step was marked applied (commit succeeded or a coherent no-op)
	commitError?: string; // set when the apply was clean but the commit failed (step NOT applied)
	note: string;
	plan: Plan; // the plan AFTER the operation (unchanged on a dry run / refusal / commit failure)
}

// The gated apply: flow a review_ready step's worktree diff into the plan integration worktree,
// then commit it there as a step-scoped commit that advances the tip. Dry-run by default (nothing
// mutates); confirm required to apply + commit. Mirrors chit_apply's safety exactly (the conflict
// and untracked-overwrite gates live in applyWorkspace): a conflict refuses the WHOLE apply, no
// silent overwrite, no cleanup coupling. The step is marked applied ONLY after the commit succeeds;
// if the apply conflicts or the commit fails, the step stays review_ready and no dependent launches.
export function applyPlanStep(
	store: PlanStore,
	deps: PlanEngineDeps,
	opts: { planId: string; stepId: string; confirm: boolean; includeUntracked?: string[] },
): PlanApplyOutcome {
	const existing = store.get(opts.planId);
	if (!existing) throw new PlanEngineError(`no plan ${JSON.stringify(opts.planId)}`);
	const step = existing.steps.find((s) => s.id === opts.stepId);
	if (!step) {
		throw new PlanEngineError(
			`no step ${JSON.stringify(opts.stepId)} in plan ${JSON.stringify(opts.planId)}`,
		);
	}
	// Only a review_ready step can be applied: a pending/running step has no converged diff, and an
	// already-applied one must not be re-applied (its diff is in the integration commit).
	if (step.status !== "review_ready") {
		throw new PlanEngineError(
			`step ${JSON.stringify(opts.stepId)} is ${step.status}, not review_ready; only a review_ready step can be applied`,
		);
	}
	if (!existing.integrationWorktree) {
		throw new PlanEngineError(
			`plan ${JSON.stringify(opts.planId)} has no integration worktree to apply into`,
		);
	}
	if (!step.worktreePath || step.baseSha === undefined) {
		throw new PlanEngineError(
			`step ${JSON.stringify(opts.stepId)} has no recorded worktree/base to apply`,
		);
	}
	assertCleanIntegrationWorktree(deps, existing.integrationWorktree);

	const apply = deps.applyWorkspace({
		worktreePath: step.worktreePath,
		baseSha: step.baseSha,
		target: existing.integrationWorktree,
		confirm: opts.confirm,
		...(opts.includeUntracked !== undefined && { includeUntracked: opts.includeUntracked }),
	});

	const base = (): Omit<PlanApplyOutcome, "stepApplied" | "note" | "plan"> => ({
		planId: opts.planId,
		stepId: opts.stepId,
		confirmed: opts.confirm,
		apply,
	});

	// Dry run, OR a confirmed apply the primitive refused (conflict / untracked overwrite): never
	// touch plan state. The step stays review_ready; the operator resolves and retries.
	if (!opts.confirm || apply.applied !== true) {
		return {
			...base(),
			stepApplied: false,
			plan: existing,
			note: opts.confirm
				? `apply refused, nothing changed: ${apply.note} The step stays review_ready.`
				: apply.note,
		};
	}

	// Guard the no-op apply BEFORE committing. applyRunWorkspace reports applied=true for an empty
	// tracked patch, and it copies ONLY explicitly-named untracked files -- so a step with no tracked
	// diff and untracked candidates that were not included lands NOTHING in the integration worktree.
	// Committing that as a no-op and marking the step applied would misrepresent it (it contributed
	// nothing) AND unlock dependents while reviewable work still sits only in the step worktree.
	// Refuse: tell the operator to include the file(s) to land them, or accept their loss. A truly
	// empty step (no tracked diff AND no untracked candidates) falls through to the coherent no-op.
	const landedTracked = apply.trackedFiles.length > 0;
	const landedUntracked = (apply.appliedUntracked?.length ?? 0) > 0;
	const strandedUntracked = apply.untracked.filter(
		(f) => !(apply.appliedUntracked ?? []).includes(f),
	);
	if (!landedTracked && !landedUntracked && strandedUntracked.length > 0) {
		return {
			...base(),
			stepApplied: false,
			plan: existing,
			note: `nothing landed in the integration worktree, but the step has untracked file(s) not included (${strandedUntracked.join(", ")}); marking it applied would strand that reviewable work and falsely unlock dependents. Re-apply with include_untracked naming the file(s) to land them, or accept their loss. The step stays review_ready.`,
		};
	}

	// Clean apply landed in the integration worktree: commit it as the step's commit. The commit
	// turns the staged patch + copied untracked files into one integration commit.
	const commit = deps.commit(existing.integrationWorktree, planStepCommitMessage(step));
	if (commit.error !== undefined || commit.sha === undefined) {
		// The diff is applied to the integration worktree but the commit FAILED: do NOT mark applied
		// and do NOT advance the tip, so no dependent launches against an uncommitted tip. The
		// integration worktree holds the applied-but-uncommitted diff for the operator to resolve.
		return {
			...base(),
			stepApplied: false,
			commitError: commit.error ?? "git produced no commit sha",
			plan: existing,
			note: `applied to the integration worktree but the commit FAILED (${commit.error ?? "no sha"}); the step is NOT marked applied and the tip did not advance. Resolve the integration worktree (${existing.integrationWorktree}) and retry.`,
		};
	}

	// Commit succeeded (or a coherent no-op committed nothing but resolved the unchanged tip): mark
	// the step applied, record the commit, and advance the tip to it -- the only state that lets a
	// dependent launch, cut from this commit. Persist atomically and re-derive the plan status.
	const sha = commit.sha;
	const plan = store.update(opts.planId, (c) => {
		const s = c.steps.find((x) => x.id === opts.stepId);
		if (s) {
			s.status = "applied";
			s.appliedCommitSha = sha;
		}
		c.integrationTipSha = sha;
		c.status = derivePlanStatus(c);
		c.updatedAt = iso(deps.now());
		return c;
	});
	return {
		...base(),
		appliedCommitSha: sha,
		integrationTipSha: sha,
		stepApplied: true,
		plan,
		note: commit.committed
			? `applied + committed step ${opts.stepId} to the integration branch (${sha}); the tip advanced. A subsequent chit_plan_advance launches the next runnable step from it.`
			: `step ${opts.stepId} produced no diff at all (no tracked changes, no untracked files); marked applied at the unchanged tip (${sha}). A subsequent chit_plan_advance launches the next runnable step.`,
	};
}

function assertCleanIntegrationWorktree(deps: PlanEngineDeps, integrationWorktree: string): void {
	const status = deps.git(["status", "--porcelain"], integrationWorktree);
	if (status.code !== 0) {
		throw new PlanEngineError(
			`could not inspect integration worktree ${JSON.stringify(integrationWorktree)}: ${status.stderr || status.stdout}`,
		);
	}
	if (status.stdout.trim() !== "") {
		throw new PlanEngineError(
			`integration worktree ${JSON.stringify(integrationWorktree)} has uncommitted changes; resolve or clean it before applying a plan step so the step commit cannot mix unrelated work`,
		);
	}
}

// --- cleanup: retire the plan's managed worktrees + branches ---------------

// Whether cleanup may run for the plan's current state. v1 rule (the simplest safe one): cleanup
// requires a TERMINAL plan -- completed (every step applied to the integration branch) or cancelled
// (the operator abandoned it) -- and refuses while ANY step is review_ready (its converged diff is
// not yet in the integration commit, so removing its worktree would silently discard reviewable
// work). running / ready_for_apply / needs_human / failed are all withheld: the operator may still
// apply, fix, rerun, or inspect, and their step worktrees hold work cleanup would destroy.
export function planCleanupReadiness(plan: Plan): { ok: true } | { ok: false; reason: string } {
	// review_ready first: it is the most actionable refusal (apply it, don't discard it), and it
	// can hide behind a terminal status (e.g. a cancelled plan with a still-review_ready step).
	if (plan.steps.some((s) => s.status === "review_ready")) {
		return {
			ok: false,
			reason:
				"a step is review_ready: its converged diff is NOT yet applied to the integration branch. Apply it (chit_plan_advance with an apply payload) or accept its loss before cleanup -- cleanup would otherwise silently discard that reviewable work.",
		};
	}
	if (plan.status !== "completed" && plan.status !== "cancelled") {
		return {
			ok: false,
			reason: `plan is ${plan.status}; cleanup requires a terminal plan (completed, or cancelled). Apply the remaining steps, or cancel the plan, before cleaning up -- the step worktrees still hold work to inspect or apply.`,
		};
	}
	return { ok: true };
}

// The steps whose background worker is still alive: a runId whose job exists and is NOT settleable
// (not terminal, not stale). cancelPlan marks a running step "cancelled" the instant it best-effort
// cancels the job, but the worker keeps running in its worktree until it actually exits -- so a
// cancelled plan's status alone does NOT prove its workers are gone. Mirrors batch cleanup's live
// check (batches/engine.ts).
function planLiveSteps(plan: Plan, deps: PlanEngineDeps): PlanStepRecord[] {
	return plan.steps.filter((s) => {
		if (!s.runId) return false;
		const job = deps.getJob(s.runId);
		return job !== undefined && !jobIsSettleable(job, deps);
	});
}

// Why cleanup is not safe to run right now, or undefined when it is. Combines the state rule
// (planCleanupReadiness) with a LIVE-WORKER check: removing a worktree from under a still-running
// worker corrupts the run, so even a terminal-status plan is withheld until its workers settle.
// Shared by cleanupPlan (the refusal) and planNextAction (the suggestion) so status and action agree.
export function planCleanupBlocker(plan: Plan, deps: PlanEngineDeps): string | undefined {
	const readiness = planCleanupReadiness(plan);
	if (!readiness.ok) return readiness.reason;
	const live = planLiveSteps(plan, deps);
	if (live.length > 0) {
		return `step(s) ${live
			.map((s) => s.id)
			.join(
				", ",
			)} still have a live worker (a cancelled step's worker settles in the background, it does not stop instantly); wait for them to settle before cleaning up -- removing a worktree from under a live worker corrupts the run.`;
	}
	return undefined;
}

export interface PlanCleanupTargetResult {
	id: string; // "integration" or a step id
	worktreePath?: string;
	branch?: string;
	removed?: boolean; // set on confirm: did THIS call retire the worktree/branch
	alreadyRemoved?: boolean; // set on confirm: nothing to do (idempotent re-run)
	error?: string;
}

export interface PlanCleanupResult {
	planId: string;
	confirmed: boolean; // false = dry run (nothing removed)
	available: boolean; // is cleanup allowed for this plan's current state?
	refusal?: string; // set when !available (nothing removed, even on confirm)
	// The integration branch's committed step count, surfaced so the dry run can WARN that removing
	// the integration worktree also deletes the branch carrying these applied commits.
	appliedCommits: number;
	targets: PlanCleanupTargetResult[]; // the integration + step worktrees this would/did retire
	receiptsKept: true; // cleanup NEVER deletes plan/job/loop/audit records
	cleanedAt?: string; // set on a confirmed cleanup
	// The plan's worktree ROOT (~/worktrees/chit/<planId>) and whether cleanup actually removed it, so
	// an operator can audit the empty-parent cleanup from the receipt alone. planRootPath is reported
	// whenever it can be derived (dry run included). planRootRemoved is set ONLY on a confirmed run
	// that reached the empty-only removal: true if the now-empty root was dropped, false if a stray
	// file kept it (it is never true on a dry run, which removes nothing).
	planRootPath?: string;
	planRootRemoved?: boolean;
	note: string;
}

// Retire a plan's chit-managed worktrees + branches (integration + every recorded step worktree).
// Dry-run by default (reports what it would remove, removes nothing); confirm required to remove.
// NEVER deletes durable records -- the plan record, job records, loop logs, and audit receipts all
// survive (only cleanedAt is stamped). Refuses (removes nothing, even on confirm) unless the plan is
// terminal and no step is review_ready (see planCleanupReadiness). Idempotent: a re-run reports
// already-removed targets rather than erroring.
export function cleanupPlan(
	store: PlanStore,
	deps: PlanEngineDeps,
	planId: string,
	confirm: boolean,
): PlanCleanupResult {
	const existing = store.get(planId);
	if (!existing) throw new PlanEngineError(`no plan ${JSON.stringify(planId)}`);
	const appliedCommits = existing.steps.filter((s) => s.status === "applied").length;
	// The managed worktrees cleanup owns: the integration worktree first, then each step that
	// recorded one (a step that never launched its worktree has nothing to retire).
	const integration =
		existing.integrationWorktree !== undefined
			? {
					id: "integration",
					worktreePath: existing.integrationWorktree,
					branch: existing.integrationBranch,
				}
			: undefined;
	const stepTargets = existing.steps
		.filter((s) => s.worktreePath !== undefined && s.branch !== undefined)
		.map((s) => ({
			id: s.id,
			worktreePath: s.worktreePath as string,
			branch: s.branch as string,
		}));
	const planned = [...(integration ? [integration] : []), ...stepTargets];

	// The plan's worktree ROOT (~/worktrees/chit/<planId>). Derived from the RECORDED integration path
	// (authoritative; the integration worktree sits directly under the root), falling back to a step
	// path (steps/<id> -> two levels up). Surfaced on the receipt so the parent cleanup is auditable.
	const planRoot =
		existing.integrationWorktree !== undefined
			? dirname(existing.integrationWorktree)
			: stepTargets.length > 0
				? dirname(dirname(stepTargets[0].worktreePath))
				: undefined;

	const blocker = planCleanupBlocker(existing, deps);
	if (blocker !== undefined) {
		// Refuse: report what WOULD be removed (transparency) but remove nothing, even on confirm.
		return {
			planId,
			confirmed: confirm,
			available: false,
			refusal: blocker,
			appliedCommits,
			targets: planned.map((t) => ({
				id: t.id,
				worktreePath: t.worktreePath,
				branch: t.branch,
			})),
			receiptsKept: true,
			note: blocker,
		};
	}

	const integrationWarn =
		appliedCommits > 0
			? ` Removing the integration worktree also deletes the integration branch (${existing.integrationBranch}) carrying ${appliedCommits} applied commit(s); make sure you have merged or applied it elsewhere first.`
			: "";

	if (!confirm) {
		return {
			planId,
			confirmed: false,
			available: true,
			appliedCommits,
			targets: planned.map((t) => ({
				id: t.id,
				worktreePath: t.worktreePath,
				branch: t.branch,
			})),
			receiptsKept: true,
			...(planRoot !== undefined && { planRootPath: planRoot }),
			note: `dry run: would remove ${planned.length} plan-managed worktree(s) + branch(es) (integration + ${stepTargets.length} step worktree(s)).${integrationWarn} Plan/job/loop/audit records are kept. Pass confirm=true to remove.`,
		};
	}

	const targets: PlanCleanupTargetResult[] = planned.map((t) => {
		const r = deps.removeWorktree(existing.repo, t.worktreePath, t.branch);
		if (!r.ok) {
			return { id: t.id, worktreePath: t.worktreePath, branch: t.branch, error: r.error };
		}
		const didRemove = r.removedWorktree || r.removedBranch;
		return {
			id: t.id,
			worktreePath: t.worktreePath,
			branch: t.branch,
			removed: didRemove,
			...(didRemove ? {} : { alreadyRemoved: true }),
		};
	});

	// Stamp cleanedAt ONLY when every removal succeeded, so the field's meaning ("the managed
	// worktrees/branches were retired") stays honest: a partial failure leaves cleanedAt unset, the
	// per-target errors + note report it, and an idempotent re-run retires the stragglers. The plan
	// record itself (and all receipts) is KEPT either way. Mirrors batch cleanup (batches/engine.ts).
	const failures = targets.filter((t) => t.error !== undefined);
	let cleanedAt: string | undefined;
	let planRootRemoved: boolean | undefined;
	if (failures.length === 0) {
		const stamp = iso(deps.now());
		cleanedAt = stamp;
		store.update(planId, (c) => {
			c.cleanedAt = stamp;
			c.updatedAt = stamp;
			return c;
		});
		// Every child worktree is gone: drop the now-empty plan worktree ROOT (~/worktrees/chit/<planId>)
		// so a cleaned plan leaves no empty litter. The nested layout (the integration worktree beside a
		// steps/ dir) means removeWorktree's own per-worktree parent cleanup never reaches this root, so
		// remove it explicitly. Best-effort + empty-only, so an operator's stray file under the root
		// leaves it intact -- planRootRemoved records which of those two outcomes happened.
		if (planRoot !== undefined) planRootRemoved = deps.removeEmptyDir(planRoot);
	}
	return {
		planId,
		confirmed: true,
		available: true,
		appliedCommits,
		targets,
		receiptsKept: true,
		...(cleanedAt !== undefined && { cleanedAt }),
		...(planRoot !== undefined && { planRootPath: planRoot }),
		...(planRootRemoved !== undefined && { planRootRemoved }),
		note: failures.length
			? `removed ${targets.length - failures.length} of ${targets.length}; ${failures.length} failed (${failures.map((f) => f.id).join(", ")}) -- the plan is NOT marked cleaned, inspect and re-run to retire the rest. Plan/job/loop/audit records are kept.`
			: `removed ${targets.length} plan-managed worktree(s) + branch(es). Plan/job/loop/audit records are kept.`,
	};
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
		// Snapshot the compact loop receipt into the durable step so a terminal row answers
		// "what happened?" after the live job join is gone. Same loop records as changedFiles
		// above, so no extra read; absent when the log had no readable records.
		if (detail.receipt !== undefined) step.receipt = detail.receipt;
	}
	if (extra.job) {
		step.auditRefs = extra.job.auditRefs;
		if (extra.job.stopStatus !== undefined) step.stopStatus = extra.job.stopStatus;
		if (extra.job.lastVerdict !== undefined) step.lastVerdict = extra.job.lastVerdict;
		if (extra.job.lastVerification !== undefined)
			step.lastVerification = extra.job.lastVerification;
		if (extra.job.lastVerificationSource !== undefined)
			step.lastVerificationSource = extra.job.lastVerificationSource;
		// Snapshot provenance into the durable step so a terminal row keeps it after the live job
		// join is gone (immutable for the run, so the job's value is the value that ran).
		if (extra.job.participants !== undefined) step.participants = extra.job.participants;
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
		// Launch-time execution-contract verification: re-resolve the step's manifest binding
		// from the commit THIS step is cut from (an earlier step may have edited the manifest;
		// the config may have changed since approval -- a long plan can launch hours later) and
		// pause needs_human on any drift, BEFORE creating a worktree or spawning a worker.
		// Confirm-time verification alone is not enough here.
		const drift = stepManifestDrift(c, next, base, deps);
		if (drift !== undefined) {
			next.status = "needs_human";
			next.error = `manifest execution drift detected before launch: ${drift}. The step paused instead of silently running a changed execution surface; review the drift, then re-approve a fresh plan or abort.`;
			c.status = derivePlanStatus(c);
			c.updatedAt = iso(deps.now());
			return c;
		}
		try {
			// Link tooling from the checkout the plan was launched from (callerCheckout), so a step's
			// fresh worktree resolves installed binaries exactly like the launch checkout does.
			const { worktreePath, branch } = deps.createStepWorktree(
				c.repo,
				c.id,
				next.id,
				base,
				c.callerCheckout,
			);
			next.worktreePath = worktreePath;
			next.branch = branch;
			next.baseSha = base;
			// Globally-unique loop id: the worker's loop LOCK is global by loop id, so a bare step id
			// like "schema" would collide with the same step id in another plan. The plan id namespaces it.
			const loopId = `${c.id}-${next.id}`;
			// Effective budgets: a step-level override (hash-bound through the normalized plan)
			// beats the step's APPROVED recipe defaults (hash-bound through the recipes record),
			// which beat the plan-wide default. Both sources were reviewed, so the launch never
			// reads a budget the approval did not bind.
			const recipeDefaults = c.recipes?.[next.id];
			const stepMaxIterations =
				next.maxIterations ?? recipeDefaults?.maxIterations ?? defaultMaxIterations;
			const stepCallTimeoutMs = next.callTimeoutMs ?? recipeDefaults?.callTimeoutMs;
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
				// Stamp the approved digest on the job so the detached worker re-verifies the
				// exact bytes it reads (the last read before execution).
				...(c.manifests?.[next.id]?.manifestDigest !== undefined && {
					manifestDigest: c.manifests[next.id]?.manifestDigest,
				}),
				...(c.manifests?.[next.id]?.participants !== undefined && {
					manifestParticipants: c.manifests[next.id]?.participants,
				}),
				...(next.requiredChecks !== undefined && { requiredChecks: next.requiredChecks }),
				...(stepCallTimeoutMs !== undefined && { callTimeoutMs: stepCallTimeoutMs }),
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

// Why the step's CURRENT manifest binding no longer matches the approved one, or
// undefined when it matches (or there is nothing to verify: no approved binding on
// the record, or no resolver wired). Keyed off the APPROVED binding, not the step's
// authored fields, so a recipe-backed step (whose binding the recipe resolved) is
// verified exactly like a direct-manifestPath step. The reference is re-resolved
// from `base` -- the commit the step worktree is about to be cut from -- through
// the SAME resolver shape the gate used, so an earlier step's manifest edit, a
// moved file, or a config change that re-routes participants all surface here. A
// resolution failure (manifest gone, now a symlink, config broken) is drift too:
// what was approved can no longer be read the approved way.
function stepManifestDrift(
	c: Plan,
	step: PlanStepRecord,
	base: string,
	deps: PlanEngineDeps,
): string | undefined {
	const approved = c.manifests?.[step.id];
	if (approved === undefined || deps.resolveManifestBinding === undefined) return undefined;
	try {
		const current = deps.resolveManifestBinding({
			manifestPath: approved.manifestPath,
			baseSha: base,
			// Object reads work from any checkout of the repo; the durable main repo outlives
			// a removed linked launching worktree. Config resolves from the launching checkout,
			// matching the worker's own config read point.
			gitCwd: c.repo,
			configCwd: c.callerCheckout,
		});
		return describeManifestBindingDrift(approved, current);
	} catch (e) {
		return (e as Error).message;
	}
}

// --- read-only describe (the join; NEVER launches or mutates) --------------

export interface PlanStepView {
	id: string;
	title: string;
	status: PlanStepStatus;
	dependsOn: string[];
	// The reviewed commit subject the gated apply uses for this step (from the approved plan);
	// absent means the fallback `plan step <id>: <title>` is used. Surfaced so the operator sees
	// the exact message before confirming the apply.
	commitMessage?: string;
	branch?: string;
	worktreePath?: string;
	run_id?: string; // the durable background run advancing this step (run_id == its job id)
	baseSha?: string; // the integration commit this step's worktree was cut from
	// The config recipe id the step selected (when it did), so a receipt answers which
	// vetted recipe ran; the recipe's resolved manifest reference appears as
	// manifestPath/manifestDigest below, identical to a direct-manifest step.
	recipe?: string;
	// The step's manifest reference and its APPROVED content digest (from the plan
	// record's bound manifests), so a receipt answers which execution surface was
	// approved and run. Participant provenance is `participants` below.
	manifestPath?: string;
	manifestDigest?: string;
	appliedCommitSha?: string; // the integration commit the gated apply produced (a later slice)
	// Live run state for a running step, or the recorded outcome for a terminal one.
	runState?: JobRecord["state"] | "stale";
	phase?: JobRecord["phase"];
	stopStatus?: PlanStepRecord["stopStatus"];
	lastVerdict?: PlanStepRecord["lastVerdict"];
	lastVerification?: PlanStepRecord["lastVerification"];
	lastVerificationSource?: PlanStepRecord["lastVerificationSource"];
	// Execution provenance for the step's loop job: which agent/adapter/session/permissions/config
	// each participant ran with. Joined live from the loop job while running; from the snapshotted
	// step record once terminal. Absent until the job exists or on a legacy record.
	participants?: LoopJobRecord["participants"];
	// The effective per-call timeout (ms) this step runs under, surfaced alongside provenance so the
	// operator can see the active budget (mirrors the batch task view). Absent -> agent config / default.
	callTimeoutMs?: number;
	changedFiles?: string[];
	workspaceWarnings?: string[];
	auditRefs?: string[];
	// The compact loop receipt for a SETTLED step (review_ready / applied / needs_human /
	// failed / cancelled), snapshotted at settle and surfaced straight from the step record.
	// Absent while running (no receipt before the step settles) and on a legacy record. The
	// same safe LoopReceipt shape v0.38 single-run views use -- no participants, env values,
	// prompts, outputs, or blob bodies. Kept out of chit_plan_list summaries.
	receipt?: LoopReceipt;
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
	cleanedAt?: string;
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

// The wait-state of a plan for chit_wait. Mirrors batchWaitState, adapted to the plan's
// operator-gated forward flow. "terminal": the plan has settled (completed / cancelled / failed /
// needs_human) -- nothing left to wait on or advance. "ready_for_apply": a step converged and its
// diff waits on the operator's gated apply; surface it at once rather than blocking (no live job to
// wait on). "needs_advance": chit_plan_advance would do real work now -- a finished, stale, or
// vanished step job can reconcile, or the next chain step can launch. "working": a step's job is
// queued/running and live, so the next advance would do nothing yet -- keep waiting. This is
// READ-ONLY: it never advances, reconciles, applies, or launches; progress still happens through
// chit_plan_advance.
export function planWaitState(
	c: Plan,
	deps: PlanEngineDeps,
): "terminal" | "ready_for_apply" | "needs_advance" | "working" {
	const status = derivePlanStatus(c);
	// A review_ready step waits on the operator's gated apply; report it immediately. Checked before
	// the terminal fold because ready_for_apply is a live, actionable plan, not a settled one.
	if (status === "ready_for_apply") return "ready_for_apply";
	// completed / cancelled / failed / needs_human: the plan has settled. needs_human folds in here
	// (a step paused for a human decision with no live job to wait on); the plan view's nextAction
	// explains the decision the operator must make.
	if (status !== "running") return "terminal";
	// Still running: an advance does real work only when a step's job is reconcilable (finished,
	// stale, or vanished) or the next chain step can launch. Otherwise a live step is in flight.
	if (anyReconcilable(c, deps) || selectNextStep(c)) return "needs_advance";
	return "working";
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
			...(s.commitMessage !== undefined && { commitMessage: s.commitMessage }),
			...(s.branch !== undefined && { branch: s.branch }),
			...(s.worktreePath !== undefined && { worktreePath: s.worktreePath }),
			...(s.runId !== undefined && { run_id: s.runId }),
			...(s.baseSha !== undefined && { baseSha: s.baseSha }),
			...(s.appliedCommitSha !== undefined && { appliedCommitSha: s.appliedCommitSha }),
			...(s.recipe !== undefined && { recipe: s.recipe }),
			...(s.manifestPath !== undefined && { manifestPath: s.manifestPath }),
			...(c.manifests?.[s.id]?.manifestDigest !== undefined && {
				manifestDigest: c.manifests[s.id]?.manifestDigest,
			}),
			// The effective per-call budget for this step (a step override beats the approved
			// recipe default), surfaced like the batch task view does, so status shows the
			// active value without the caller re-deriving it.
			...((s.callTimeoutMs ?? c.recipes?.[s.id]?.callTimeoutMs) !== undefined && {
				callTimeoutMs: s.callTimeoutMs ?? c.recipes?.[s.id]?.callTimeoutMs,
			}),
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
					// Provenance is immutable once the worker has resolved the run, so surface it
					// straight from the joined loop job without waiting for the step to settle.
					if (job.participants !== undefined) view.participants = job.participants;
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
		// Terminal provenance from the snapshotted step record, so a settled row keeps it (the live
		// job join only runs while the step is "running").
		if (s.participants !== undefined) view.participants = s.participants;
		if (s.changedFiles !== undefined) view.changedFiles = s.changedFiles;
		if (s.workspaceWarnings !== undefined) view.workspaceWarnings = s.workspaceWarnings;
		if (s.auditRefs !== undefined) view.auditRefs = s.auditRefs;
		// The snapshotted loop receipt, surfaced for a settled row only -- it is recorded ONLY
		// at settle, so a running step (which may carry live verdict/participant joins above)
		// never has one. A review_ready/applied/needs_human/failed/cancelled row keeps it after
		// the live job join is gone.
		if (s.receipt !== undefined) view.receipt = s.receipt;
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
		...(c.cleanedAt !== undefined && { cleanedAt: c.cleanedAt }),
		status: c.status,
		steps,
		nextAction: planNextAction(c, deps),
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
	};
}

// The next tool call the operator should make, named explicitly (an agent follows nextAction
// literally). The forward flow always passes through the operator gate: a review_ready step waits
// for the gated apply (chit_plan_advance with an apply payload), never advancing on its own. The
// cleanup suggestion is appended ONLY when cleanup is actually available (planCleanupBlocker -- the
// state rule AND no live worker) AND the plan was not ALREADY cleaned (cleanedAt unset), so this
// publicly-surfaced text never points at an operation that would be refused (e.g. a just-cancelled
// plan whose worker has not yet settled) or already happened (re-running cleanup on a cleaned plan).
function planNextAction(c: Plan, deps: PlanEngineDeps): string {
	// A cleaned plan already retired its managed worktrees, so report that terminal state instead of
	// suggesting cleanup again; an uncleaned terminal plan still gets the cleanup suggestion when no
	// blocker stands. The two clauses are mutually exclusive by construction (cleanedAt vs not).
	const cleaned = c.cleanedAt !== undefined;
	const cleanedClause = cleaned
		? `The plan-managed worktrees and branches were already retired (cleaned ${c.cleanedAt}); plan/job/loop/audit receipts remain available.`
		: "";
	const cleanupClause =
		!cleaned && planCleanupBlocker(c, deps) === undefined
			? " When you no longer need the worktrees, retire them with chit_plan_cleanup (dry run first, then confirm=true)."
			: "";
	if (c.status === "completed") {
		return cleaned
			? `plan completed: every step was applied. ${cleanedClause}`
			: `every step is applied and committed to the integration branch (${c.integrationBranch}); review it, then merge/apply it through your usual flow.${cleanupClause}`;
	}
	if (c.status === "cancelled") {
		// A cleaned cancelled plan no longer has step worktrees to inspect, so do not point at them.
		return cleaned
			? `plan cancelled. ${cleanedClause}`
			: `plan cancelled (running jobs settle in the background; worktrees are kept for inspection). Review what landed in the step worktrees (changedFiles).${cleanupClause}`;
	}
	if (c.status === "failed") {
		return "a step failed during execution (a dead worker, a worktree error, or a thrown run -- see the step's status/error); inspect its worktree (changedFiles may be empty if it broke mid-review) and receipt, then fix and rerun the step or abort the plan.";
	}
	if (c.status === "needs_human") {
		return "a step paused for a human decision: its run completed but did not converge clean (the reviewer blocked, approved-but-unverified, or ran out of iterations). Inspect its worktree (changedFiles) and receipt, then fix and rerun, raise the budget and rerun, or abort.";
	}
	if (c.status === "ready_for_apply") {
		const ready = c.steps.find((s) => s.status === "review_ready");
		const which = ready ? ` (step ${ready.id})` : "";
		// Surface the exact commit subject the confirmed apply will use, so the operator sees it
		// before confirming -- it is bound by the approval hash, never a confirm-time override.
		const commitClause = ready
			? `The apply commits the diff onto the integration branch as "${planStepCommitMessage(ready)}", advances the tip, and unblocks the next dependent step.`
			: `The apply commits the diff onto the integration branch, advances the tip, and unblocks the next dependent step.`;
		return `a step is review_ready${which}: its run converged and its diff sits uncommitted in its worktree (chit_plan_status lists changedFiles). Review it, then apply it with chit_plan_advance { apply: { step_id, confirm: true } } -- a dry run (no confirm) reports what would land first. ${commitClause}`;
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
