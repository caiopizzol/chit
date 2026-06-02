// The background run worker: a detached process that advances ONE background run to
// a terminal state, updating the durable job record as it goes. It dispatches on
// the job's policy:
//   - loop: the convergeLoop driver (implement/review iterations to a stop record),
//     using the SAME core path as foreground converge (runConvergeIteration -> loop
//     log + audit), so a background loop is identical on disk to a foreground one.
//     The enqueue side reserves the loop (startLoop) and writes the queued job; the
//     worker runs the iterations and writes the stop record, holding the per-loop
//     lock for its whole run so a foreground advance cannot touch the same loop.
//   - one-shot: a single manifest run to completion via runManifestOnce. No loop, no
//     loop log, no loop lock; its history is the one audit transcript.
//
// Durability + control (both policies):
//   - state transitions and heartbeats go to the JobStore (durable, survives MCP
//     reconnect); a loop run's iterations live in the loop log, transcripts in audit.
//   - cancellation is intent-first: a persisted cancelRequestedAt (checked before
//     work and between iterations) plus a process-group signal (aborts in-flight
//     work). Either way the run closes as a clean `cancelled` terminal state.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type NormalizedManifest, parseManifest } from "@chit-run/core";
import { loadRegistry } from "../agents/parse.ts";
import {
	type ConvergeExecute,
	ConvergeExecuteError,
	type LoopSteps,
	prepareConvergeExecute,
	runConvergeIteration,
} from "../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../cli/default-converge-manifest.ts";
import { stopLoop } from "../loops/log-store.ts";
import { type RunOnceResult, runManifestOnce, validateOneShotAuth } from "../runs/run-once.ts";
import type { TraceEvent } from "../runtime/types.ts";
import { acquireLock, LockError, type LockOptions, releaseLock } from "./lock.ts";
import type { JobStore } from "./store.ts";
import type { JobPhase, JobRecord, JobState, LoopJobRecord, OneShotJobRecord } from "./types.ts";

type ExecuteResolution =
	| { ok: true; execute: ConvergeExecute; loopSteps: LoopSteps }
	| { ok: false; error: string };

// Run a one-shot job's manifest to completion. Injected in tests to drive the
// one-shot worker path without real agents (mirrors resolveExecute for loops).
type RunOnce = (
	job: OneShotJobRecord,
	opts: { signal: AbortSignal; onTrace?: (e: TraceEvent) => void },
) => Promise<RunOnceResult>;

export interface JobWorkerDeps {
	jobStore: JobStore;
	// Build the converge execute for a job. Default: load the registry, read the
	// job's manifest (or the embedded default), and prepareConvergeExecute. Tests
	// inject a fake execute to drive iterations without real agents.
	resolveExecute?: (job: LoopJobRecord) => ExecuteResolution;
	// Run a one-shot job's manifest once (default: defaultRunOnce). Tests inject a
	// fake to drive the one-shot path without real agents.
	runOnce?: RunOnce;
	now?: () => number;
	// Heartbeat cadence; tests set it very high to disable the timer.
	heartbeatMs?: number;
	loopLockOpts?: LockOptions;
	// Install SIGTERM/SIGINT handlers (real process). Tests pass false and drive
	// cancellation via the persisted cancelRequestedAt instead.
	installSignalHandlers?: boolean;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// converged / max-iterations / needs-decision / blocked all mean the loop reached
// a terminal verdict: the JOB completed (the stopStatus carries the nuance).
// `cancelled` is the only stop that maps to a cancelled job; a broken manifest run
// is handled on its own branch as `failed`.
function defaultResolveExecute(job: LoopJobRecord): ExecuteResolution {
	let raw: unknown;
	if (job.manifestPath) {
		const path = isAbsolute(job.manifestPath)
			? job.manifestPath
			: resolve(job.cwd, job.manifestPath);
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			return { ok: false, error: `could not read manifest at ${path}: ${(e as Error).message}` };
		}
	} else {
		raw = DEFAULT_CONVERGE_MANIFEST;
	}
	const prep = prepareConvergeExecute(raw, loadRegistry(), job.scope, job.cwd, job.allowUnenforced);
	return prep.ok
		? { ok: true, execute: prep.execute, loopSteps: prep.loopSteps }
		: { ok: false, error: prep.error };
}

// Run the job to a terminal state. Safe to call once per worker process; if the
// job is missing or not `queued`, it returns without touching anything (idempotent
// against a double spawn). Dispatches on policy: a loop run drives the converge
// iteration loop; a one-shot run executes its manifest exactly once.
export async function runJobWorker(jobId: string, deps: JobWorkerDeps): Promise<void> {
	const job = deps.jobStore.get(jobId);
	if (job?.state !== "queued") return;
	if (job.policy === "loop") return runLoopJob(jobId, job, deps);
	return runOneShotJob(jobId, job, deps);
}

// --- shared worker lifecycle (policy-agnostic) ---------------------------

// The queued -> running patch (publishes this worker's identity; spawned detached,
// so this process is its own group leader: pgid === pid). Shared by the loop
// transition (an unconditional update) and the one-shot claim (an atomic CAS on
// still-queued), so both write identical running state.
function runningPatch(now: () => number, workerToken: string): (c: JobRecord) => JobRecord {
	return (c) => ({
		...c,
		state: "running",
		startedAt: iso(now()),
		pid: process.pid,
		pgid: process.pid,
		workerToken,
		lastHeartbeatAt: iso(now()),
		phase: "starting",
		phaseStartedAt: iso(now()),
	});
}

// Flip queued -> running unconditionally. The loop run relies on its loop lock
// (acquired next) to serialize advancers, so the transition itself need not claim.
function transitionToRunning(
	store: JobStore,
	jobId: string,
	now: () => number,
	workerToken: string,
): void {
	store.update(jobId, runningPatch(now, workerToken));
}

// A phase setter bound to one job: records the phase, refreshes the heartbeat, and
// resets the phase clock only on a real transition (so a repeated phase, e.g. the
// pre-iteration write plus the implement step.started trace, does not keep
// restarting the age).
function makeSetPhase(
	store: JobStore,
	jobId: string,
	now: () => number,
): (phase: JobPhase) => void {
	return (phase) => {
		try {
			store.update(jobId, (c) => ({
				...c,
				phase,
				...(c.phase !== phase && { phaseStartedAt: iso(now()) }),
				lastHeartbeatAt: iso(now()),
			}));
		} catch {
			// best effort; a lost job file surfaces elsewhere
		}
	};
}

// Intent-first cancellation. Install the handlers BEFORE the caller publishes the
// worker's pid/pgid: a chit cancel signals the process group as soon as it sees a
// pid, so an early signal must hit this handler (which aborts the controller)
// rather than the default SIGTERM that would kill the worker before it records a
// clean cancelled stop. Returns the controller and a cleanup that removes the
// handlers.
function installCancellation(
	setPhase: (phase: JobPhase) => void,
	install: boolean | undefined,
): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	const onSignal = () => {
		setPhase("cancelling");
		controller.abort();
	};
	if (install !== false) {
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
	}
	return {
		controller,
		cleanup: () => {
			if (install !== false) {
				process.removeListener("SIGTERM", onSignal);
				process.removeListener("SIGINT", onSignal);
			}
		},
	};
}

function startHeartbeat(
	store: JobStore,
	jobId: string,
	now: () => number,
	heartbeatMs: number,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		try {
			store.update(jobId, (c) => ({ ...c, lastHeartbeatAt: iso(now()) }));
		} catch {
			// best effort
		}
	}, heartbeatMs);
}

// --- loop policy: drive the converge iteration loop to a terminal state --

async function runLoopJob(jobId: string, job: LoopJobRecord, deps: JobWorkerDeps): Promise<void> {
	const store = deps.jobStore;
	const now = deps.now ?? Date.now;
	const heartbeatMs = deps.heartbeatMs ?? 10_000;
	const resolveExecute = deps.resolveExecute ?? defaultResolveExecute;

	const workerToken = crypto.randomUUID();
	const setPhase = makeSetPhase(store, jobId, now);
	const { controller, cleanup } = installCancellation(setPhase, deps.installSignalHandlers);

	let loopLock: ReturnType<typeof acquireLock> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		transitionToRunning(store, jobId, now, workerToken);

		const resolved = resolveExecute(job);
		if (!resolved.ok) {
			// Manifest could not be prepared in this process. The loop header exists
			// (the caller reserved it); close it blocked so it is not left open.
			stopLoopSafely(job, "blocked", `could not prepare converge execute: ${resolved.error}`);
			finish(store, jobId, now, "failed", { failure: resolved.error });
			return;
		}

		// Hold the per-loop lock for the whole run: one advancer per loop.
		try {
			loopLock = acquireLock(store.loopLockPath(job.loopId), deps.loopLockOpts);
		} catch (e) {
			if (e instanceof LockError) {
				finish(store, jobId, now, "failed", {
					failure: `loop "${job.loopId}" is locked by another advancer; not started`,
				});
				return;
			}
			throw e;
		}

		heartbeat = startHeartbeat(store, jobId, now, heartbeatMs);

		let priorReview = "";
		for (let i = 1; i <= job.maxIterations; i++) {
			// Close cleanly with NO further iteration on a persisted cancel intent OR
			// a signal that already aborted us during startup (handler installed above).
			if (store.get(jobId)?.cancelRequestedAt || controller.signal.aborted) {
				stopLoopSafely(job, "cancelled", "cancelled via chit_job_cancel");
				finish(store, jobId, now, "cancelled", { stopStatus: "cancelled" });
				return;
			}

			store.update(jobId, (c) => ({
				...c,
				iteration: i,
				phase: "implementing",
				...(c.phase !== "implementing" && { phaseStartedAt: iso(now()) }),
				lastHeartbeatAt: iso(now()),
			}));

			let iter: Awaited<ReturnType<typeof runConvergeIteration>>;
			try {
				iter = await runConvergeIteration({
					cwd: job.cwd,
					loopId: job.loopId,
					iteration: i,
					task: job.task,
					prior_review: priorReview,
					execute: resolved.execute,
					implementStep: resolved.loopSteps.implementStep,
					reviewStep: resolved.loopSteps.reviewStep,
					signal: controller.signal,
					onTrace: (e: TraceEvent) => {
						if (e.type === "step.started" && e.stepId === resolved.loopSteps.implementStep)
							setPhase("implementing");
						else if (e.type === "step.started" && e.stepId === resolved.loopSteps.reviewStep)
							setPhase("reviewing");
					},
				});
			} catch (e) {
				if (e instanceof ConvergeExecuteError) {
					stopLoopSafely(job, "blocked", `manifest run threw: ${e.message}`);
					finish(store, jobId, now, "failed", { failure: e.message });
				} else {
					// Post-run append failure: leave the loop as-is (no stop), mark failed.
					finish(store, jobId, now, "failed", { failure: (e as Error).message });
				}
				return;
			}

			if (!iter.ok) {
				// A failed run can still have produced an audit transcript before it
				// broke. Preserve that ref so the terminal job points at its receipt
				// instead of reporting empty auditRefs while a transcript sits on disk.
				if (iter.auditRunId) {
					const ref = iter.auditRunId;
					store.update(jobId, (c) => ({ ...c, auditRefs: [...c.auditRefs, ref] }));
				}
				if (controller.signal.aborted) {
					stopLoopSafely(job, "cancelled", "cancelled mid-iteration (signal)");
					finish(store, jobId, now, "cancelled", { stopStatus: "cancelled" });
				} else {
					stopLoopSafely(job, "blocked", iter.failure);
					finish(store, jobId, now, "failed", { failure: iter.failure });
				}
				return;
			}

			// Iteration recorded (loop log owns it). Summarize into the job record.
			store.update(jobId, (c) => ({
				...c,
				phase: "recording",
				...(c.phase !== "recording" && { phaseStartedAt: iso(now()) }),
				iterationsCompleted: i,
				lastVerdict: iter.verdict,
				auditRefs: iter.auditRunId ? [...c.auditRefs, iter.auditRunId] : c.auditRefs,
				lastHeartbeatAt: iso(now()),
			}));

			if (iter.stopStatus) {
				// proceed -> converged, block -> blocked. The loop already has no stop
				// record; close it here (the worker is the loop's driver).
				const reason =
					iter.stopStatus === "converged" ? "reviewer returned proceed" : "reviewer returned block";
				stopLoopSafely(job, iter.stopStatus, reason);
				finish(store, jobId, now, "completed", { stopStatus: iter.stopStatus });
				return;
			}

			priorReview = iter.reviewText;
			if (i >= job.maxIterations) {
				stopLoopSafely(
					job,
					"max-iterations",
					`reached max iterations (${job.maxIterations}) without converging`,
				);
				finish(store, jobId, now, "completed", { stopStatus: "max-iterations" });
				return;
			}
		}
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		cleanup();
		if (loopLock) releaseLock(loopLock);
	}
}

// --- one-shot policy: execute the manifest exactly once ------------------

async function runOneShotJob(
	jobId: string,
	job: OneShotJobRecord,
	deps: JobWorkerDeps,
): Promise<void> {
	const store = deps.jobStore;
	const now = deps.now ?? Date.now;
	const heartbeatMs = deps.heartbeatMs ?? 10_000;
	const runOnce = deps.runOnce ?? defaultRunOnce;

	const workerToken = crypto.randomUUID();
	const setPhase = makeSetPhase(store, jobId, now);
	const { controller, cleanup } = installCancellation(setPhase, deps.installSignalHandlers);
	// Intent-first cancellation: honor a persisted cancel even if no signal was
	// delivered (signal loss, or a runner that does not observe the abort), so a
	// one-shot run never finishes completed/failed against a recorded cancel.
	const cancelled = () =>
		controller.signal.aborted || store.get(jobId)?.cancelRequestedAt !== undefined;

	let heartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		// Claim queued -> running. A one-shot run has no loop lock, so this atomic
		// claim is the only thing stopping a double-spawned worker from running the
		// manifest twice; losing the claim means another worker already owns this run.
		if (!store.claim(jobId, runningPatch(now, workerToken))) return;

		// A cancel seen before any work closes the run immediately; no transcript yet.
		if (cancelled()) {
			finish(store, jobId, now, "cancelled", {});
			return;
		}

		// A one-shot run is a single DAG pass: one "running" phase (no implement/
		// review/recording cycle) and no loop lock (there is no loop to serialize).
		setPhase("running");
		heartbeat = startHeartbeat(store, jobId, now, heartbeatMs);

		let result: RunOnceResult;
		try {
			result = await runOnce(job, { signal: controller.signal });
		} catch (e) {
			// A throw can be the abort propagating; an intent-first cancel wins over
			// reporting failed.
			if (cancelled()) finish(store, jobId, now, "cancelled", {});
			else finish(store, jobId, now, "failed", { failure: (e as Error).message });
			return;
		}

		// Record the single transcript when one was written (present only on a clean
		// audit), so the terminal job points at its receipt -- even when cancelled.
		if (result.auditRunId) {
			const ref = result.auditRunId;
			store.update(jobId, (c) => ({ ...c, auditRefs: [...c.auditRefs, ref] }));
		}

		if (cancelled()) {
			finish(store, jobId, now, "cancelled", {});
		} else if (result.ok) {
			finish(store, jobId, now, "completed", {});
		} else {
			finish(store, jobId, now, "failed", {
				failure:
					result.error ??
					(result.failedStep ? `run failed at step ${result.failedStep}` : "run failed"),
			});
		}
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		cleanup();
	}
}

// Default one-shot runner: read + parse the job's manifest, load the registry, and
// run it once with the audited + session-wrapped adapter stack (surface "mcp").
// The manifest was validated at enqueue (launchRun), so this trusts it and
// surfaces any residual load/run error as a failed run.
async function defaultRunOnce(
	job: OneShotJobRecord,
	opts: { signal: AbortSignal; onTrace?: (e: TraceEvent) => void },
): Promise<RunOnceResult> {
	const path = isAbsolute(job.manifestPath) ? job.manifestPath : resolve(job.cwd, job.manifestPath);
	let manifest: NormalizedManifest;
	try {
		manifest = parseManifest(JSON.parse(readFileSync(path, "utf-8")));
	} catch (e) {
		return { ok: false, error: `could not load manifest at ${path}: ${(e as Error).message}` };
	}
	// Re-validate governance in this process. launchRun validated at enqueue, but
	// the manifest file may have changed since; re-run the same checks (with the
	// persisted allow-unenforced decision) so a now-invalid manifest cannot run.
	const auth = validateOneShotAuth(manifest, loadRegistry(), {
		...(job.scope !== undefined && { scope: job.scope }),
		allowUnenforced: job.allowUnenforced,
	});
	if (!auth.ok) return { ok: false, error: auth.error };
	return runManifestOnce(manifest, {
		inputs: job.inputs,
		registry: loadRegistry(),
		invocationCwd: job.cwd,
		surface: "mcp",
		...(job.scope !== undefined && { scope: job.scope }),
		audit: job.audit,
		signal: opts.signal,
		...(opts.onTrace && { onTrace: opts.onTrace }),
	});
}

// Best-effort stop record. A failure to write the stop must not mask the terminal
// job state we are about to write; the open loop is still inspectable via the job.
function stopLoopSafely(
	job: LoopJobRecord,
	status: Parameters<typeof stopLoop>[2]["status"],
	reason: string,
): void {
	try {
		stopLoop(job.cwd, job.loopId, { status, reason });
	} catch {
		// leave the loop open; the terminal job state still records what happened
	}
}

// Write the terminal job state with endedAt and clear the live phase (and its
// clock): a terminal job is in no phase, so phaseElapsedMs should not be derived.
function finish(
	store: JobStore,
	jobId: string,
	now: () => number,
	state: JobState,
	extra: { stopStatus?: LoopJobRecord["stopStatus"]; failure?: string },
): void {
	store.update(jobId, (c) => ({
		...c,
		state,
		endedAt: iso(now()),
		phase: undefined,
		phaseStartedAt: undefined,
		lastHeartbeatAt: iso(now()),
		...(extra.stopStatus !== undefined && { stopStatus: extra.stopStatus }),
		...(extra.failure !== undefined && { failure: extra.failure }),
	}));
}
