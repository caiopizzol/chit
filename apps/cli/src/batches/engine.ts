// Batch engine: the thin coordinator. It plans a task graph, creates one
// worktree per task, and launches a durable background converge job per runnable
// task. It owns NO execution -- the loop/audit/cancellation live in the job and
// loop/audit stores it references by id. All side effects (worktrees, jobs) are
// injected as deps, so the scheduling/reconciliation logic is unit-testable
// without touching real git or spawning workers.
//
// No daemon: progress happens only at explicit tool calls. start launches the
// first wave; advance reconciles finished jobs and launches the next wave;
// describe is READ-ONLY (never launches or mutates); cancel stops active jobs.

import type {
	BatchManifestBindings,
	BatchRecipeBindings,
	BoundParticipantSummary,
	ManifestBinding,
	RecipeReceipt,
	RequiredCheck,
} from "@chit-run/core";
import { describeManifestBindingDrift } from "@chit-run/core";
import type { JobRecord, LoopJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import { pickRequiredChecks } from "../loops/required-checks.ts";
import type { ResolveManifestBinding, ResolveRecipe } from "../manifest/binding.ts";
import { planTasks, resolveManifestPath, type TaskInput } from "./plan.ts";
import { deriveBatchStatus, isBlocked, isStartable, selectRunnable } from "./schedule.ts";
import type { BatchStore } from "./store.ts";
import {
	type Batch,
	type BatchTask,
	MAX_PARALLEL_CAP,
	type TaskResult,
	type TaskStatus,
} from "./types.ts";
import {
	describePartialWork,
	type GitRunner,
	mainRepoOfWorktree,
	type PartialWork,
	repoToplevel,
	resolveBaseSha,
	WorktreeError,
} from "./worktree.ts";

export class BatchEngineError extends Error {}

export interface LaunchJobParams {
	cwd: string; // the task's worktree
	scope: string;
	task: string; // the task body (the converge implementer's brief)
	loopId: string;
	manifestPath?: string;
	// The APPROVED manifest content digest for the task's effective manifest reference,
	// forwarded so the job record carries it and the worker re-verifies the bytes it
	// actually reads.
	manifestDigest?: string;
	// The APPROVED participant execution summary for the same manifest binding. Forwarded
	// to the worker so config drift after enqueue cannot silently change the agent/model surface.
	manifestParticipants?: Record<string, BoundParticipantSummary>;
	// The APPROVED recipe receipt that applies to this task (its own selection, else the
	// batch-level default). Forwarded so the loop header and audit receipts stamp which
	// vetted recipe ran (identity + defaults only; the manifest binding above stays the
	// execution surface).
	recipe?: RecipeReceipt;
	maxIterations: number;
	// The task's effective override (task ?? batch checks); launchJob resolves it
	// against the manifest's checks at the snapshot boundary.
	requiredChecks?: RequiredCheck[];
	// The task's effective call-timeout override (ms): task ?? batch. Forwarded to the
	// converge job, which applies it to every participant's adapter.
	callTimeoutMs?: number;
	// The task's chit-managed worktree, recorded on the JOB RECORD (not just the batch task
	// state) so chit_apply / chit_cleanup resolve a batch task's diff exactly like a single
	// background run -- the parity the single-run background path already has. Every task
	// worktree is cut from the batch's baseSha; `repo` is the durable main repo cleanup retires
	// from (owns the shared .git), `callerCheckout` is chit_apply's default target (the checkout
	// chit_batch_start launched from) -- DISTINCT when launched from a linked worktree, equal for
	// a main-repo launch. Always set: launchWave creates the worktree before it launches the job.
	worktree: {
		worktreePath: string;
		branch: string;
		baseSha: string;
		repo: string;
		callerCheckout: string;
	};
}

// Everything the engine touches that has a side effect or reads external state,
// injected so tests can drive it deterministically.
export interface BatchEngineDeps {
	git: GitRunner; // read-only repo queries (toplevel, base sha resolution)
	// Create the task's isolated worktree + branch off baseSha (real: a wrapper
	// over createTaskWorktree with realGit). Injected separately from `git` so the
	// fs-touching step is faked in tests. Throws WorktreeError on failure.
	createWorktree: (
		repo: string,
		batchId: string,
		taskId: string,
		baseSha: string,
		toolingSource: string,
	) => { worktreePath: string; branch: string };
	// Launch a background converge job in the task's worktree; returns its ids.
	launchJob: (p: LaunchJobParams) => { jobId: string; loopId: string };
	// Read a durable job record (real: JobStore.get).
	getJob: (jobId: string) => JobRecord | undefined;
	// Request cancellation of a job (real: the chit_job_cancel path).
	cancelJob: (jobId: string) => void;
	// Whether a running job's worker is gone/silent (real: isStale(job, now)).
	isStale: (job: JobRecord) => boolean;
	// The latest loop iteration's changed files / workspace warnings for a task's
	// worktree (real: read the loop log). Empty when no iteration ran.
	loopDetail: (
		worktreePath: string,
		loopId: string,
	) => {
		changedFiles: string[];
		workspaceWarnings: string[];
		// The worktree's UNCOMMITTED state (real: inspectPartialWork), so a task that failed mid-step
		// can surface work no completed iteration captured. Absent when not inspected.
		partialWork?: PartialWork;
	};
	// Re-resolve a manifest reference's CURRENT binding (content digest + participant
	// summary) so a task launch can compare it to the approved one and refuse the task
	// on drift. Optional: when absent, no launch-time verification runs (a record with
	// no approved bindings has nothing to verify against either). The real
	// implementation loads fresh config per call, matching the worker's lifecycle.
	resolveManifestBinding?: ResolveManifestBinding;
	// Resolve a task's (or the batch-level) config recipe to its effective execution
	// surface at the chit_batch_start gate, so the approval hash binds what the recipe
	// RESOLVES TO, not the id string. Optional for the same reason resolveManifestBinding
	// is (test harnesses; production always wires it); a recipe-naming batch is REFUSED
	// at the gate when it is absent -- silently launching without the recipe's manifest
	// would run an execution surface nobody reviewed. Mirrors PlanEngineDeps.resolveRecipe.
	resolveRecipe?: ResolveRecipe;
	// Remove a task's worktree + branch (real: removeTaskWorktree with realGit).
	// Injected so cleanup is testable without touching real git/fs. Only called by
	// cleanupBatch, only for terminal tasks, only under an explicit confirm.
	removeWorktree?: (
		repo: string,
		worktreePath: string,
		branch: string,
	) => { ok: true } | { ok: false; error: string };
	now: () => number; // epoch ms
}

const DEFAULT_MAX_ITERATIONS = 3;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export interface StartBatchOptions {
	id: string; // generated by the caller (uuid)
	cwd: string; // any path in the target repo
	tasks: TaskInput[];
	maxParallel: number;
	baseBranch?: string; // default: the repo's current HEAD
	// Batch-level config recipe id (a default for tasks without their own recipe or
	// manifestPath). The gate resolves it; its binding arrives via `manifests.batch`
	// and its receipt via `recipes.batch`.
	recipe?: string;
	manifestPath?: string; // batch-level default converge manifest
	maxIterations?: number;
	// Batch-level chit-executed verification, applied to any task without its own.
	requiredChecks?: RequiredCheck[];
	// Batch-level call-timeout override (ms), applied to any task without its own.
	callTimeoutMs?: number;
	// The APPROVED manifest bindings from the gate's dry run, persisted on the batch
	// record so every task launch re-verifies against exactly what was approved.
	manifests?: BatchManifestBindings;
	// The APPROVED recipe receipts from the gate's dry run (batch default + per-task
	// selections), persisted so launches read the approved defaults, never live config.
	recipes?: BatchRecipeBindings;
}

// Create the batch, persist it, and launch the initial runnable wave.
export function startBatch(
	store: BatchStore,
	deps: BatchEngineDeps,
	opts: StartBatchOptions,
): Batch {
	const tasks = planTasks(opts.tasks); // throws PlanError on a bad graph
	// A recipe-backed task records its recipe's RESOLVED manifest reference (from the
	// approved binding the gate produced) as its own manifestPath, so launch, drift
	// re-verification, and receipts read one reference shape for recipe-backed and
	// direct-manifest tasks alike (planTasks guarantees recipe and an AUTHORED
	// manifestPath never coexist). Mirrors the plan engine's step records.
	for (const t of tasks) {
		if (t.recipe === undefined) continue;
		const bound = opts.manifests?.tasks?.[t.id];
		if (bound !== undefined) t.manifestPath = bound.manifestPath;
	}
	// Same stamping for a batch-level recipe: its resolved manifest reference becomes
	// the batch-level default manifest (the gate enforces recipe/manifest_path mutual
	// exclusivity, so nothing is overwritten here).
	const batchManifestPath =
		opts.manifestPath ??
		(opts.recipe !== undefined ? opts.manifests?.batch?.manifestPath : undefined);
	// Split the durable cleanup anchor from the launching checkout, mirroring the single-run
	// prepareRunWorkspace. `repo` is the main repo that owns the shared .git (survives the
	// launching linked worktree being removed before cleanup); `callerCheckout` is the checkout
	// the batch was launched from (chit_apply's default target).
	const repo = mainRepoOfWorktree(deps.git, opts.cwd);
	const callerCheckout = repoToplevel(deps.git, opts.cwd);
	const baseBranch = opts.baseBranch ?? "HEAD";
	// baseSha resolves against the LAUNCHING checkout, never the main repo: the default HEAD must
	// be the launcher's HEAD, so a feature-branch launch from a linked worktree branches off that
	// feature's tip -- not the main repo's HEAD (which would silently batch off the wrong base).
	const baseSha = resolveBaseSha(deps.git, callerCheckout, baseBranch);
	const maxParallel = Math.max(1, Math.min(opts.maxParallel, MAX_PARALLEL_CAP));
	const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	const now = iso(deps.now());
	const batch: Batch = {
		schema: 1,
		id: opts.id,
		repo,
		callerCheckout,
		repoKey: repoKey(opts.cwd), // informational; the store keys its path by this too
		baseBranch,
		baseSha,
		maxParallel,
		// Persist the EFFECTIVE budget so every later wave (advanceBatch) launches with the
		// approved value, not the advance-time default.
		maxIterations,
		...(opts.recipe !== undefined && { recipe: opts.recipe }),
		...(batchManifestPath !== undefined && { manifestPath: batchManifestPath }),
		...(opts.requiredChecks !== undefined && { requiredChecks: opts.requiredChecks }),
		...(opts.callTimeoutMs !== undefined && { callTimeoutMs: opts.callTimeoutMs }),
		...(opts.manifests !== undefined && { manifests: opts.manifests }),
		...(opts.recipes !== undefined && { recipes: opts.recipes }),
		status: "planning",
		tasks,
		createdAt: now,
		updatedAt: now,
	};
	store.create(batch);

	// Launch the first wave, then persist the resulting state.
	return store.update(opts.id, (c) => launchWave(c, deps, maxIterations));
}

// Reconcile finished jobs into task state, then launch the next runnable wave.
// The only progression trigger besides start. Returns the updated batch.
export function advanceBatch(
	store: BatchStore,
	deps: BatchEngineDeps,
	id: string,
	maxIterations = DEFAULT_MAX_ITERATIONS,
): Batch {
	const existing = store.get(id);
	if (!existing) throw new BatchEngineError(`no batch ${JSON.stringify(id)}`);
	if (existing.status === "cancelled") return existing;
	return store.update(id, (c) => launchWave(reconcile(c, deps), deps, maxIterations));
}

// Cancel every active job and close the batch. Pending tasks become cancelled;
// a running task's job is asked to cancel and the task is marked cancelled (its
// job settles cleanly in the background).
export function cancelBatch(store: BatchStore, deps: BatchEngineDeps, id: string): Batch {
	const existing = store.get(id);
	if (!existing) throw new BatchEngineError(`no batch ${JSON.stringify(id)}`);
	return store.update(id, (c) => {
		for (const t of c.tasks) {
			if (t.status === "running" && t.jobId) {
				try {
					deps.cancelJob(t.jobId);
				} catch {
					// best effort; the persisted intent (task cancelled) still stands
				}
				t.status = "cancelled";
			} else if (t.status === "pending") {
				t.status = "cancelled";
			}
		}
		c.status = "cancelled";
		c.updatedAt = iso(deps.now());
		return c;
	});
}

// One task's entry in a cleanup plan/result: what worktree + branch it has, the
// changed files that removal would discard, and (after confirm) whether removal
// succeeded.
export interface CleanupTaskEntry {
	id: string;
	status: TaskStatus;
	worktreePath?: string;
	branch?: string;
	changedFiles: string[]; // the diff that removal discards (from the loop record)
	removed?: boolean;
	error?: string;
}

export interface CleanupResult {
	batch_id: string;
	confirmed: boolean; // false = dry run (nothing removed)
	removable: CleanupTaskEntry[]; // terminal tasks with a worktree
	skipped: Array<{ id: string; status: TaskStatus; reason: string }>;
	receiptsKept: true; // cleanup never deletes batch/job/loop/audit records
	note: string;
}

// Retire a batch's worktrees + branches. SAFETY: refuses while any task is
// still running (a live worker is in that worktree); only ever removes worktrees
// for TERMINAL tasks (review_ready / needs_attention / failed / cancelled). Default is a DRY RUN
// (confirm=false): it reports exactly which worktrees/branches would be removed
// and which changed-file diffs that would discard, and removes nothing. With
// confirm=true it removes them via deps.removeWorktree. It NEVER deletes the
// batch/job/loop/audit receipts; those stay as proof history. Idempotent: a
// task whose worktree is already gone is reported removed with no error.
export function cleanupBatch(
	store: BatchStore,
	deps: BatchEngineDeps,
	id: string,
	opts: { confirm: boolean },
): CleanupResult {
	const existing = store.get(id);
	if (!existing) throw new BatchEngineError(`no batch ${JSON.stringify(id)}`);
	// Refuse cleanup while any task's WORKER is still alive. Checking task.status
	// alone is not enough: cancelBatch marks a task "cancelled" but only SIGTERMs
	// the worker -- it does not wait for exit -- so a cancelled task's worker may
	// still be mid-iteration in its worktree. A task is safe to clean only when it
	// has no live job: its job is terminal or stale (jobIsSettleable), or it never
	// launched (no jobId). Removing a worktree from under a live worker would
	// corrupt the in-flight run.
	const alive = existing.tasks.filter((t) => {
		if (!t.jobId) return false;
		const job = deps.getJob(t.jobId);
		return job !== undefined && !jobIsSettleable(job, deps);
	});
	if (alive.length > 0) {
		throw new BatchEngineError(
			`batch ${JSON.stringify(id)} still has live worker(s) for task(s): ${alive
				.map((t) => t.id)
				.join(", ")}. Cancel (chit_batch_cancel) and wait for them to settle before cleaning up.`,
		);
	}

	const removable: CleanupTaskEntry[] = [];
	const skipped: CleanupResult["skipped"] = [];
	for (const t of existing.tasks) {
		if (!t.worktreePath || !t.branch) {
			// pending/never-launched tasks have no worktree to clean
			skipped.push({ id: t.id, status: t.status, reason: "no worktree (task never launched)" });
			continue;
		}
		removable.push({
			id: t.id,
			status: t.status,
			worktreePath: t.worktreePath,
			branch: t.branch,
			changedFiles: t.result?.changedFiles ?? [],
		});
	}

	if (!opts.confirm) {
		return {
			batch_id: id,
			confirmed: false,
			removable,
			skipped,
			receiptsKept: true,
			note:
				removable.length === 0
					? "dry run: no worktrees to remove. Pass confirm=true to mark the batch cleaned."
					: `dry run: would remove ${removable.length} worktree(s) + branch(es), discarding the listed changed-file diffs. Receipts (batch/job/audit) are kept. Pass confirm=true to remove.`,
		};
	}

	const remove = deps.removeWorktree;
	if (!remove) throw new BatchEngineError("cleanup not available: no worktree remover configured");
	for (const entry of removable) {
		if (!entry.worktreePath || !entry.branch) continue;
		// Run git from the main repo (existing.repo), never from the worktree being
		// removed (git refuses to remove the current working tree).
		const r = remove(existing.repo, entry.worktreePath, entry.branch);
		entry.removed = r.ok;
		if (!r.ok) entry.error = r.error;
	}
	const failed = removable.filter((e) => e.removed === false).length;
	// Stamp cleanedAt only when every removal succeeded, so the field's meaning
	// ("the worktrees/branches were removed") stays honest. A partial failure
	// leaves cleanedAt unset; the result note + per-entry errors report it, and a
	// re-run (idempotent) can retire the stragglers.
	if (failed === 0) {
		store.update(id, (c) => ({ ...c, cleanedAt: iso(deps.now()), updatedAt: iso(deps.now()) }));
	}

	return {
		batch_id: id,
		confirmed: true,
		removable,
		skipped,
		receiptsKept: true,
		note:
			failed === 0
				? `removed ${removable.length} worktree(s) + branch(es); batch/job/audit receipts kept.`
				: `removed ${removable.length - failed} of ${removable.length}; ${failed} failed (see per-task error). Receipts kept.`,
	};
}

// --- internal: reconcile + launch (pure over the batch + deps) ----------

// Fold each running task's current job state into its task status. A job that
// reached a terminal state (or whose worker is stale) settles the task.
function reconcile(c: Batch, deps: BatchEngineDeps): Batch {
	for (const t of c.tasks) {
		if (t.status !== "running" || !t.jobId) continue;
		const job = deps.getJob(t.jobId);
		if (!job) {
			// The job record vanished; treat as failed so the batch does not hang.
			settleTask(t, "failed", deps, { failure: "job record not found" });
			continue;
		}
		if (job.policy !== "loop") {
			// A batch task always launches a loop (converge) run, so a non-loop job
			// here is an invariant violation, not a real outcome. Settle it failed
			// rather than misreport convergence fields a one-shot run does not have.
			settleTask(t, "failed", deps, { failure: "batch task job is not a loop run" });
			continue;
		}
		// `job` is a LoopJobRecord from here (the batch only runs loop policy).
		// A queued OR running job is still in flight: leave the task running UNLESS
		// the worker is gone/silent (isStale covers both a queued worker that never
		// started and a running worker that went dark). A just-launched queued job is
		// NOT a failure, so an immediate advance after start must not settle it.
		const inFlight = job.state === "queued" || job.state === "running";
		if (inFlight) {
			if (deps.isStale(job)) {
				settleTask(t, "failed", deps, { job, failure: "worker appears dead (stale job)" });
			}
			continue; // still working (or just settled stale); nothing more to do
		}
		// Terminal job states. converged is the only clean outcome (review_ready). A
		// COMPLETED-but-not-converged run -- the reviewer blocked, approved-but-
		// unverified (needs-decision), or ran out of iterations (max-iterations) -- is a
		// review judgment, NOT an execution failure: settle needs_attention so a human
		// decides (fix / rerun / discard) without it reading as a broken run, and
		// without satisfying any dependent (only review_ready does). Only a genuinely
		// failed run (state === "failed": the manifest threw or returned ok:false; the
		// vanished / non-loop / stale cases are handled above) settles failed.
		if (job.state === "completed") {
			settleTask(t, job.stopStatus === "converged" ? "review_ready" : "needs_attention", deps, {
				job,
			});
		} else if (job.state === "cancelled") {
			settleTask(t, "cancelled", deps, { job });
		} else {
			settleTask(t, "failed", deps, {
				job,
				failure: job.failure ?? `run failed (${job.stopStatus ?? "failed"})`,
			});
		}
	}
	return c;
}

// True when a running task's job would settle on the next advance: it reached a
// terminal state, or its worker is gone/silent (stale). A queued/running job that
// is NOT stale is still in flight and is NOT reconcilable. Shared by reconcile's
// intent and describe's nextAction so status and advance agree.
function jobIsSettleable(job: JobRecord, deps: BatchEngineDeps): boolean {
	if (job.state === "queued" || job.state === "running") return deps.isStale(job);
	return true; // completed / cancelled / failed
}

function settleTask(
	t: BatchTask,
	status: Extract<TaskStatus, "review_ready" | "needs_attention" | "failed" | "cancelled">,
	deps: BatchEngineDeps,
	extra: { job?: LoopJobRecord; failure?: string },
): void {
	t.status = status;
	// Loop detail comes from an actual loop job's loop log (keyed by its loopId).
	// With no loop job in hand (the record vanished, or a non-loop job was
	// rejected upstream), there is no loop detail to read.
	const detail =
		t.worktreePath && extra.job ? deps.loopDetail(t.worktreePath, extra.job.loopId) : undefined;
	const result: TaskResult = {
		iterations: extra.job?.iterationsCompleted ?? 0,
		changedFiles: detail?.changedFiles ?? [],
		workspaceWarnings: detail?.workspaceWarnings ?? [],
		auditRefs: extra.job?.auditRefs ?? [],
	};
	if (extra.job?.stopStatus !== undefined) result.stopStatus = extra.job.stopStatus;
	if (extra.job?.lastVerdict !== undefined) result.lastVerdict = extra.job.lastVerdict;
	if (extra.job?.lastVerification !== undefined)
		result.lastVerification = extra.job.lastVerification;
	if (extra.job?.lastVerificationSource !== undefined)
		result.lastVerificationSource = extra.job.lastVerificationSource;
	// Snapshot provenance into the durable result so a terminal task row keeps it after the live
	// job join is gone (immutable for the run, so the job's value is the value that ran).
	if (extra.job?.participants !== undefined) result.participants = extra.job.participants;
	// A failed task can leave real uncommitted work in its worktree that changedFiles (which only
	// reflects completed iterations) misses. Surface it so the work is findable, not assumed lost.
	if (status === "failed" && detail?.partialWork && t.worktreePath) {
		const pw = describePartialWork(detail.partialWork, t.worktreePath, extra.failure);
		if (pw) result.partialWork = pw;
	}
	t.result = result;
	if (status === "failed" && extra.failure !== undefined) t.error = extra.failure;
}

// Launch the next runnable wave: create a worktree + job per selected task,
// flipping it to running. Mutates and re-derives the batch status.
function launchWave(c: Batch, deps: BatchEngineDeps, maxIterations: number): Batch {
	if (c.status === "cancelled") return c;
	const runnable = selectRunnable(c);
	for (const task of runnable) {
		const t = c.tasks.find((x) => x.id === task.id);
		if (!t) continue;
		// Launch-time execution-contract verification: re-resolve the task's effective
		// manifest binding from the batch base and refuse the task on any drift, BEFORE
		// creating its worktree or spawning a worker. A failed task in the existing batch
		// vocabulary; the rest of the batch goes on.
		const drift = taskManifestDrift(c, t, deps);
		if (drift !== undefined) {
			t.status = "failed";
			t.error = `manifest execution drift detected before launch: ${drift}. The task was refused instead of silently running a changed execution surface; re-run the dry run and re-approve.`;
			continue;
		}
		try {
			const { worktreePath, branch } = deps.createWorktree(
				c.repo,
				c.id,
				t.id,
				c.baseSha,
				c.callerCheckout ?? c.repo,
			);
			// Record the worktree+branch IMMEDIATELY, before launching the job. If
			// launchJob then fails, the task is failed but its worktree is still
			// recorded, so cleanup can find and remove it (otherwise the worktree is
			// orphaned on disk with no reference).
			t.worktreePath = worktreePath;
			t.branch = branch;
			// Globally-unique loop id: the worker's loop LOCK is global by loop id
			// (jobs/locks/<loopId>.lock), so a bare task id like "docs" would collide
			// with the same task id in another batch. The batch uuid namespaces it.
			const loopId = `${c.id}-${t.id}`;
			// Per-task effective override: task checks beat batch checks (closest wins).
			// launchJob resolves this against the manifest's checks at the snapshot boundary.
			const taskChecks = pickRequiredChecks(t.requiredChecks, c.requiredChecks);
			// Scalar budgets, first-defined-wins: an explicit task value beats the task
			// recipe's APPROVED default, which beats the batch-level effective value (the
			// gate already folded the batch recipe's default into c.callTimeoutMs /
			// c.maxIterations, so an explicit batch override beats a batch recipe default
			// by construction). Every source here was hash-bound at approval.
			const recipeDefaults = taskRecipeDefaults(c, t);
			const taskCallTimeoutMs = t.callTimeoutMs ?? recipeDefaults?.callTimeoutMs ?? c.callTimeoutMs;
			const taskMaxIterations =
				t.maxIterations ?? recipeDefaults?.maxIterations ?? c.maxIterations ?? maxIterations;
			// The receipt the run is stamped with: the task's own selection, else the
			// batch-level default when it applies (so loop headers and audit receipts
			// answer which vetted recipe ran).
			const taskRecipe = taskApprovedRecipe(c, t);
			const { jobId } = deps.launchJob({
				cwd: worktreePath,
				scope: `batch-${c.id}-${t.id}`,
				task: t.body,
				loopId,
				// Record the managed worktree on the job record so chit_apply can reconstruct and
				// land this task's diff (baseSha -> worktree), and default its target to where the
				// batch was launched. baseSha/repo/callerCheckout come off the batch: every task
				// worktree is cut from c.baseSha; c.repo is the durable main repo cleanup retires
				// from, c.callerCheckout the launching checkout chit_apply defaults its target to.
				worktree: {
					worktreePath,
					branch,
					baseSha: c.baseSha,
					repo: c.repo,
					// ?? c.repo: a pre-split batch record (no callerCheckout) resumed/advanced after
					// upgrade carries only repo; fall back to it rather than forward undefined.
					callerCheckout: c.callerCheckout ?? c.repo,
				},
				...(resolveManifestPath(t, c.manifestPath) !== undefined && {
					manifestPath: resolveManifestPath(t, c.manifestPath),
				}),
				// Stamp the approved digest on the job so the detached worker re-verifies the
				// exact bytes it reads (the last read before execution).
				...(taskApprovedBinding(c, t) !== undefined && {
					manifestDigest: taskApprovedBinding(c, t)?.manifestDigest,
				}),
				...(taskApprovedBinding(c, t)?.participants !== undefined && {
					manifestParticipants: taskApprovedBinding(c, t)?.participants,
				}),
				...(taskRecipe !== undefined && { recipe: taskRecipe }),
				...(taskChecks && { requiredChecks: taskChecks }),
				...(taskCallTimeoutMs !== undefined && { callTimeoutMs: taskCallTimeoutMs }),
				maxIterations: taskMaxIterations,
			});
			t.jobId = jobId;
			t.status = "running";
		} catch (e) {
			// A worktree or launch failure fails just this task; the batch goes on.
			// worktreePath/branch (if the worktree was created) stay recorded so
			// cleanup can still retire it.
			t.status = "failed";
			t.error = e instanceof WorktreeError ? e.message : (e as Error).message;
		}
	}
	c.status = deriveBatchStatus(c);
	c.updatedAt = iso(deps.now());
	return c;
}

// The APPROVED binding for a task's effective manifest reference, mirroring
// resolveManifestPath's precedence: the task's own override binds under its id,
// else the batch-level default binding. Undefined when nothing was bound (no
// manifest reference, or a record that predates the binding).
function taskApprovedBinding(c: Batch, t: BatchTask): ManifestBinding | undefined {
	if (t.manifestPath !== undefined) return c.manifests?.tasks?.[t.id];
	return c.manifests?.batch;
}

// The APPROVED recipe receipt that applies to a task: its own selection (t.recipe is
// checked FIRST: a recipe-backed task also carries its recipe's stamped manifestPath),
// else the batch-level default for a task with no manifest reference of its own
// (matching the batch recipe's scope: a default for tasks without their own recipe or
// manifestPath). Undefined for a direct-manifest task and on records predating recipes.
function taskApprovedRecipe(c: Batch, t: BatchTask): RecipeReceipt | undefined {
	if (t.recipe !== undefined) return c.recipes?.tasks?.[t.id];
	if (t.manifestPath !== undefined) return undefined;
	return c.recipes?.batch;
}

// The recipe defaults that participate in this task's budget precedence: ONLY the
// task's own recipe's. The batch recipe's defaults are deliberately excluded -- the
// gate folds them into the batch-level effective knobs (explicit input first), so
// applying them here would let a batch recipe default beat an explicit batch override.
function taskRecipeDefaults(c: Batch, t: BatchTask): RecipeReceipt | undefined {
	return t.recipe !== undefined ? c.recipes?.tasks?.[t.id] : undefined;
}

// Why the task's CURRENT manifest binding no longer matches the approved one, or
// undefined when it matches (or there is nothing to verify: no manifest reference,
// no approved binding, or no resolver wired). Every batch task is cut from the
// batch base, so the reference is re-resolved from c.baseSha; a resolution failure
// (manifest gone, now a symlink, config broken) is drift too.
function taskManifestDrift(c: Batch, t: BatchTask, deps: BatchEngineDeps): string | undefined {
	const approved = taskApprovedBinding(c, t);
	if (approved === undefined || deps.resolveManifestBinding === undefined) return undefined;
	try {
		const current = deps.resolveManifestBinding({
			manifestPath: approved.manifestPath,
			baseSha: c.baseSha,
			gitCwd: c.repo,
			configCwd: c.callerCheckout ?? c.repo,
		});
		return describeManifestBindingDrift(approved, current);
	} catch (e) {
		return (e as Error).message;
	}
}

// --- read-only describe (the join; NEVER launches or mutates) --------------

export interface BatchTaskView {
	id: string;
	title: string;
	status: TaskStatus;
	dependencies: string[];
	branch?: string;
	worktreePath?: string;
	run_id?: string; // the durable background run advancing this task (run_id == its job id)
	// Live run state for a running task, or the recorded result for a terminal one.
	runState?: JobRecord["state"] | "stale";
	phase?: JobRecord["phase"];
	stopStatus?: TaskResult["stopStatus"];
	lastVerdict?: TaskResult["lastVerdict"];
	lastVerification?: TaskResult["lastVerification"];
	lastVerificationSource?: TaskResult["lastVerificationSource"];
	changedFiles?: string[];
	workspaceWarnings?: string[];
	auditRefs?: string[];
	// Uncommitted work in a FAILED task's worktree that changedFiles missed (see TaskResult).
	partialWork?: TaskResult["partialWork"];
	// The EFFECTIVE per-call timeout (ms) this task runs under (task ?? task recipe ??
	// batch), surfaced so the operator can see the active budget. Absent -> agent
	// config / default.
	callTimeoutMs?: number;
	// The config recipe id that applies to this task (its own selection, else the
	// batch-level default when it applies), so a batch view answers which vetted recipe
	// each task runs -- id only, never prompts, env values, or manifest content.
	recipe?: string;
	// The APPROVED manifest content digest for the task's effective manifest reference
	// (task override, else the batch default), so a receipt answers which execution
	// surface was approved and run. Participant provenance is `participants` below.
	manifestDigest?: string;
	// Execution provenance for the task's loop job: which agent/adapter/session/permissions/config
	// each participant ran with. Joined live from the loop job (persisted at enqueue); absent until
	// the job exists or on a legacy record.
	participants?: LoopJobRecord["participants"];
	error?: string;
}

export interface BatchView {
	batch_id: string;
	repo: string;
	baseBranch: string;
	baseSha: string;
	maxParallel: number;
	status: Batch["status"];
	tasks: BatchTaskView[];
	runnableCount: number;
	nextAction: string;
	createdAt: string;
	updatedAt: string;
	// Set once a confirmed chit_batch_cleanup retired the batch-managed worktrees + branches.
	// Additive: absent on a batch that was never cleaned. Mirrors BatchSummary.cleanedAt.
	cleanedAt?: string;
}

// Does the batch have a running task whose job would settle on the next advance
// (terminal or stale)? Shared by describeBatch's nextAction and chit_wait so
// status, advance, and wait all agree on "is there reconcilable work."
export function anyReconcilable(c: Batch, deps: BatchEngineDeps): boolean {
	return c.tasks.some((t) => {
		if (t.status !== "running" || !t.jobId) return false;
		const job = deps.getJob(t.jobId);
		// A VANISHED job record (undefined) is reconcilable too: reconcile() settles it
		// to failed so the batch never hangs. The predicate must match that, or
		// batchWaitState reports "working" while advanceBatch would actually do work.
		return job === undefined || jobIsSettleable(job, deps);
	});
}

// The wait-state of a batch for chit_wait. "terminal": the batch has settled (no
// task active or startable -- ready_for_review / failed / cancelled / needs_human),
// nothing left to advance. "needs_advance": chit_batch_advance would do real work
// now -- a runnable task can launch, or a finished/staled job can be reconciled.
// "working": tasks are in flight and the next advance would do nothing yet.
export function batchWaitState(
	c: Batch,
	deps: BatchEngineDeps,
): "terminal" | "needs_advance" | "working" {
	if (deriveBatchStatus(c) !== "running") return "terminal";
	if (selectRunnable(c).length > 0 || anyReconcilable(c, deps)) return "needs_advance";
	return "working";
}

// Read-only join of batch state + live job state. Computes how many tasks
// would launch on the next advance, but launches NOTHING. Inspection is safe.
export function describeBatch(c: Batch, deps: BatchEngineDeps): BatchView {
	const tasks: BatchTaskView[] = c.tasks.map((t) => {
		const view: BatchTaskView = {
			id: t.id,
			title: t.title,
			status: t.status,
			dependencies: t.dependencies,
			...(t.branch !== undefined && { branch: t.branch }),
			...(t.worktreePath !== undefined && { worktreePath: t.worktreePath }),
			...(t.jobId !== undefined && { run_id: t.jobId }),
			// The effective budget for this task (task override beats its recipe default,
			// which beats the batch value), so status shows the active value without the
			// caller re-deriving the precedence. Same chain as launchWave's.
			...((t.callTimeoutMs ?? taskRecipeDefaults(c, t)?.callTimeoutMs ?? c.callTimeoutMs) !==
				undefined && {
				callTimeoutMs:
					t.callTimeoutMs ?? taskRecipeDefaults(c, t)?.callTimeoutMs ?? c.callTimeoutMs,
			}),
			// The vetted recipe this task runs (own selection, else the applicable batch
			// default): id from the approved receipt, falling back to the authored id.
			...((taskApprovedRecipe(c, t)?.id ?? t.recipe) !== undefined && {
				recipe: taskApprovedRecipe(c, t)?.id ?? t.recipe,
			}),
			...(taskApprovedBinding(c, t) !== undefined && {
				manifestDigest: taskApprovedBinding(c, t)?.manifestDigest,
			}),
		};
		if (t.status === "running" && t.jobId) {
			const job = deps.getJob(t.jobId);
			if (job) {
				view.runState = job.state === "running" && deps.isStale(job) ? "stale" : job.state;
				if (job.phase !== undefined) view.phase = job.phase;
				// Surface the live cached signal from the most recent completed iteration, so a
				// mid-loop task (or one whose job has finished but is not yet reconciled into
				// t.result) shows its verdict + verification instead of a blank. Reconcile later
				// copies the final values from t.result; until then the live job is the source.
				// A batch task is always a loop job; narrow for the loop-only cached fields.
				if (job.policy === "loop") {
					if (job.lastVerdict !== undefined) view.lastVerdict = job.lastVerdict;
					if (job.lastVerification !== undefined) view.lastVerification = job.lastVerification;
					if (job.lastVerificationSource !== undefined)
						view.lastVerificationSource = job.lastVerificationSource;
					// Provenance is immutable once the worker has resolved the run, so surface it
					// straight from the joined loop job without waiting for the task to settle.
					if (job.participants !== undefined) view.participants = job.participants;
				}
			}
		}
		if (t.result) {
			if (t.result.stopStatus !== undefined) view.stopStatus = t.result.stopStatus;
			if (t.result.lastVerdict !== undefined) view.lastVerdict = t.result.lastVerdict;
			if (t.result.lastVerification !== undefined)
				view.lastVerification = t.result.lastVerification;
			if (t.result.lastVerificationSource !== undefined)
				view.lastVerificationSource = t.result.lastVerificationSource;
			// Terminal provenance from the snapshotted result, so a settled row keeps it (the live
			// job join only runs while the task is "running").
			if (t.result.participants !== undefined) view.participants = t.result.participants;
			view.changedFiles = t.result.changedFiles;
			view.workspaceWarnings = t.result.workspaceWarnings;
			view.auditRefs = t.result.auditRefs;
			if (t.result.partialWork !== undefined) view.partialWork = t.result.partialWork;
		}
		if (t.error !== undefined) view.error = t.error;
		return view;
	});

	// How many would launch on the next advance: runnable now, accounting for
	// claim-overlap and free slots (selectRunnable), PLUS reconciliation could free
	// slots, so this is a lower bound shown to the operator.
	const runnable = selectRunnable(c);
	const reconcilable = anyReconcilable(c, deps);
	const startableBlocked = c.tasks.filter((t) => isStartable(t, c)).length;
	const blocked = c.tasks.filter((t) => isBlocked(t, c)).length;
	const needsAttention = c.tasks.filter((t) => t.status === "needs_attention").length;
	const failed = c.tasks.filter((t) => t.status === "failed").length;

	// Every terminal state shares one close-out instruction. Naming the next tool
	// call matters: an agent follows nextAction literally, and the old bare "review
	// the task worktrees" wording (no audit/cleanup pointer) led one to wrongly tell
	// a user to pass the batch_id to chit_audit_show -- receipts open by audit_ref, a
	// different handle. So spell out: the work is uncommitted, receipts open by
	// audit_ref, worktrees retire with chit_batch_cleanup.
	const reviewAndRetire =
		"Review the uncommitted changes in each completed task's worktree (changedFiles lists them; nothing is committed or merged), open a task's receipt with chit_audit_show { audit_ref } (each task lists its auditRefs), and retire the worktrees with chit_batch_cleanup when done.";

	// After a confirmed chit_batch_cleanup the batch-managed worktrees + branches are already retired,
	// so terminal guidance must NOT suggest chit_batch_cleanup again or point at worktrees that no
	// longer exist. The receipts survive cleanup and still open by audit_ref, so keep that pointer.
	// Mirrors plans' planNextAction cleaned handling. cleaned and uncleaned are mutually exclusive.
	const cleaned = c.cleanedAt !== undefined;
	const cleanedReceipts = `The batch-managed worktrees and branches were already retired (cleaned ${c.cleanedAt}); the task receipts remain available -- open one with chit_audit_show { audit_ref } (each task lists its auditRefs).`;

	let nextAction: string;
	if (c.status === "cancelled") {
		nextAction = cleaned
			? `batch cancelled. ${cleanedReceipts}`
			: `batch cancelled (running jobs settle in the background; worktrees are kept for inspection). ${reviewAndRetire}`;
	} else if (c.status === "ready_for_review") {
		nextAction = cleaned
			? `all tasks terminal. ${cleanedReceipts}`
			: `all tasks terminal. ${reviewAndRetire}`;
	} else if (c.status === "failed") {
		nextAction = cleaned
			? `batch failed; one or more tasks broke during execution (a dead worker, a worktree error, or a thrown run -- see each task's status/error). ${cleanedReceipts}`
			: `batch failed; one or more tasks broke during execution (a dead worker, a worktree error, or a thrown run -- see each task's status/error). ${reviewAndRetire}`;
	} else if (c.status === "needs_human") {
		// needs_human means a human must decide: a task that finished without converging
		// clean (needs_attention), a task that failed in execution while a sibling is
		// review_ready, and/or a pending task blocked by an unfinished dep. Name whichever
		// applies, and keep clean review_ready siblings reviewable. When the batch is already
		// cleaned the worktrees are gone, so route inspection to the receipts, not the worktrees.
		const parts: string[] = [];
		if (needsAttention > 0) {
			const preamble = `${needsAttention} task(s) need attention: the run completed but did not converge clean (the reviewer blocked, approved-but-unverified, or ran out of iterations).`;
			parts.push(
				cleaned
					? `${preamble} Review each one's receipt (changedFiles records what the now-retired worktree held), then decide: fix and start a fresh batch, rerun with a higher budget, or discard.`
					: `${preamble} Inspect each one's worktree (changedFiles) and receipt, then decide: fix and start a fresh batch, rerun with a higher budget, or discard.`,
			);
		}
		if (failed > 0) {
			const preamble = `${failed} task(s) failed during execution (a dead worker, a worktree error, a reviewer/adapter timeout, or a thrown run -- see each one's status/error);`;
			parts.push(
				cleaned
					? `${preamble} review each failed task's receipt (its changedFiles records what the now-retired worktree held) before deciding to rerun or discard.`
					: `${preamble} inspect each failed task's worktree directly (its changedFiles may be empty if it broke mid-review, so the work can still be there) and its receipt before deciding to rerun or discard.`,
			);
		}
		if (blocked > 0)
			parts.push(
				`${blocked} task(s) are blocked by an unfinished dependency (failed/cancelled/needs_attention) and can never run; start a fresh batch for them once the upstream is resolved.`,
			);
		if (parts.length === 0)
			parts.push("the batch is stuck with no runnable or active work; inspect the tasks.");
		parts.push("review_ready tasks (if any) can be reviewed independently.");
		nextAction = cleaned
			? `${parts.join(" ")} ${cleanedReceipts}`
			: `${parts.join(" ")} ${reviewAndRetire}`;
	} else if (runnable.length > 0 || reconcilable) {
		const n = runnable.length;
		nextAction =
			reconcilable && n === 0
				? "a job finished; call chit_batch_advance to reconcile and launch newly runnable task(s)"
				: `call chit_batch_advance to launch ${n} runnable task(s)`;
	} else {
		nextAction =
			"tasks in flight; watch with chit_batch_status (read-only, never launches), then call chit_batch_advance once it reports a finished job or a runnable task (chit_batch_cancel to stop). Follow nextAction, not the per-task status, to drive the batch.";
	}
	void startableBlocked;

	return {
		batch_id: c.id,
		repo: c.repo,
		baseBranch: c.baseBranch,
		baseSha: c.baseSha,
		maxParallel: c.maxParallel,
		status: c.status,
		tasks,
		runnableCount: runnable.length,
		nextAction,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
		...(c.cleanedAt !== undefined && { cleanedAt: c.cleanedAt }),
	};
}

// --- list (recover batch ids; compact, read-only) --------------------------

// A one-line summary per batch for the list view, so an operator who lost a
// batch id can find it again without reading state files. Counts come straight
// off the stored task statuses (no job reads), so this is cheap.
export interface BatchSummary {
	batch_id: string;
	status: Batch["status"];
	taskCount: number;
	reviewReady: number;
	needsAttention: number;
	failed: number;
	createdAt: string;
	updatedAt: string;
	cleanedAt?: string;
}

export function summarizeBatch(c: Batch): BatchSummary {
	const summary: BatchSummary = {
		batch_id: c.id,
		status: c.status,
		taskCount: c.tasks.length,
		reviewReady: c.tasks.filter((t) => t.status === "review_ready").length,
		needsAttention: c.tasks.filter((t) => t.status === "needs_attention").length,
		failed: c.tasks.filter((t) => t.status === "failed").length,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
	};
	if (c.cleanedAt !== undefined) summary.cleanedAt = c.cleanedAt;
	return summary;
}

// All batches for the repo, newest-created first, capped by `limit` when given.
// Read-only over the store (BatchStore.list already skips corrupt files).
export function listBatches(store: BatchStore, limit?: number): BatchSummary[] {
	const all = store.list().map(summarizeBatch);
	return limit !== undefined ? all.slice(0, limit) : all;
}
