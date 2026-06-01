// The background converge worker: a detached `chit job-run <jobId>` process that
// advances ONE converge loop to a terminal state, updating the durable job record
// as it goes. It is the convergeLoop driver, split: chit_converge_run reserves the
// loop (startLoop) and writes the queued job, the worker runs the iterations and
// writes the stop record. It uses the SAME core path as foreground converge
// (runConvergeIteration -> loop log + audit), so a background loop is identical on
// disk to a foreground one.
//
// Durability + control:
//   - state transitions and heartbeats go to the JobStore (durable, survives MCP
//     reconnect); the loop log owns iterations, the audit store owns transcripts.
//   - it holds the per-loop lock for its whole run so a foreground chit_converge_next
//     cannot advance the same loop concurrently.
//   - cancellation is intent-first: chit_job_cancel persists cancelRequestedAt
//     (checked between iterations) and signals the process group (aborts an
//     in-flight iteration). Either way the loop closes as a clean `cancelled` stop.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadRegistry } from "../agents/parse.ts";
import {
	type ConvergeExecute,
	ConvergeExecuteError,
	prepareConvergeExecute,
	runConvergeIteration,
} from "../cli/converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "../cli/default-converge-manifest.ts";
import { stopLoop } from "../loops/log-store.ts";
import type { TraceEvent } from "../runtime/types.ts";
import { acquireLock, LockError, type LockOptions, releaseLock } from "./lock.ts";
import type { JobStore } from "./store.ts";
import type { JobPhase, JobRecord, JobState } from "./types.ts";

type ExecuteResolution = { ok: true; execute: ConvergeExecute } | { ok: false; error: string };

export interface JobWorkerDeps {
	jobStore: JobStore;
	// Build the converge execute for a job. Default: load the registry, read the
	// job's manifest (or the embedded default), and prepareConvergeExecute. Tests
	// inject a fake execute to drive iterations without real agents.
	resolveExecute?: (job: JobRecord) => ExecuteResolution;
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
function defaultResolveExecute(job: JobRecord): ExecuteResolution {
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
	return prep.ok ? { ok: true, execute: prep.execute } : { ok: false, error: prep.error };
}

// Run the job to a terminal state. Safe to call once per worker process; if the
// job is missing or not `queued`, it returns without touching anything (idempotent
// against a double spawn).
export async function runJobWorker(jobId: string, deps: JobWorkerDeps): Promise<void> {
	const store = deps.jobStore;
	const now = deps.now ?? Date.now;
	const heartbeatMs = deps.heartbeatMs ?? 10_000;
	const resolveExecute = deps.resolveExecute ?? defaultResolveExecute;

	const job = store.get(jobId);
	if (job?.state !== "queued") return;

	const workerToken = crypto.randomUUID();
	const setPhase = (phase: JobPhase) => {
		try {
			store.update(jobId, (c) => ({ ...c, phase, lastHeartbeatAt: iso(now()) }));
		} catch {
			// best effort; a lost job file surfaces elsewhere
		}
	};

	// Install the cancel handler BEFORE publishing this worker's pid/pgid. A
	// chit_job_cancel signals the process group as soon as it sees a pid, so if
	// the handler were installed later (after resolveExecute / lock), a cancel in
	// that startup window would hit the default SIGTERM and kill the worker before
	// it could record a clean cancelled stop. With the handler up first, such a
	// signal just aborts the controller; the pre-iteration check then closes the
	// loop cleanly.
	const controller = new AbortController();
	const onSignal = () => {
		setPhase("cancelling");
		controller.abort();
	};
	if (deps.installSignalHandlers !== false) {
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
	}

	let loopLock: ReturnType<typeof acquireLock> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		// Transition queued -> running, recording this worker's identity. Spawned
		// detached, so this process is its own group leader: pgid === pid.
		store.update(jobId, (c) => ({
			...c,
			state: "running",
			startedAt: iso(now()),
			pid: process.pid,
			pgid: process.pid,
			workerToken,
			lastHeartbeatAt: iso(now()),
			phase: "starting",
		}));

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

		heartbeat = setInterval(() => {
			try {
				store.update(jobId, (c) => ({ ...c, lastHeartbeatAt: iso(now()) }));
			} catch {
				// best effort
			}
		}, heartbeatMs);

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
					signal: controller.signal,
					onTrace: (e: TraceEvent) => {
						if (e.type === "step.started" && e.stepId === "implement") setPhase("implementing");
						else if (e.type === "step.started" && e.stepId === "review") setPhase("reviewing");
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
		if (deps.installSignalHandlers !== false) {
			process.removeListener("SIGTERM", onSignal);
			process.removeListener("SIGINT", onSignal);
		}
		if (loopLock) releaseLock(loopLock);
	}
}

// Best-effort stop record. A failure to write the stop must not mask the terminal
// job state we are about to write; the open loop is still inspectable via the job.
function stopLoopSafely(
	job: JobRecord,
	status: Parameters<typeof stopLoop>[2]["status"],
	reason: string,
): void {
	try {
		stopLoop(job.cwd, job.loopId, { status, reason });
	} catch {
		// leave the loop open; the terminal job state still records what happened
	}
}

// Write the terminal job state with endedAt and clear the live phase.
function finish(
	store: JobStore,
	jobId: string,
	now: () => number,
	state: JobState,
	extra: { stopStatus?: JobRecord["stopStatus"]; failure?: string },
): void {
	store.update(jobId, (c) => ({
		...c,
		state,
		endedAt: iso(now()),
		phase: undefined,
		lastHeartbeatAt: iso(now()),
		...(extra.stopStatus !== undefined && { stopStatus: extra.stopStatus }),
		...(extra.failure !== undefined && { failure: extra.failure }),
	}));
}
