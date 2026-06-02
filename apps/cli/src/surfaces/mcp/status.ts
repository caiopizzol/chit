// chit_status assembly: the read-only operator overview that answers "what is
// live in this MCP server right now, and what should I do next?" plus a compact
// "what recently finished" from the durable audit store. chit's MCP-native
// analogue to a workflows progress view, with no UI.
//
// Two sources with different lifetimes, joined here and kept distinct in the
// output:
//   - active: the in-memory foreground runs (the merged controller store, both
//     one-shot DAG runs and converge loops). Per-server-process and
//     session-scoped: a new MCP server (a new Claude Code session) starts empty,
//     and idle runs are evicted. This is the controllable, live control plane.
//   - recent: the durable audit store (~/.local/state/chit/audit), which spans
//     processes and sessions. This is history, not control.
//
// Pure and side-effect-free BY DESIGN: it does NOT sweep or touch the in-memory
// stores. Touching on a status poll would keep runs alive forever (defeating
// idle eviction); sweeping would make a read destructive. Eviction stays tied to
// chit_start, where it belongs. The active sections read
// only in-memory state (no disk), so they never throw; only `recent` touches
// disk, via listAudit, which is already robust to a corrupt or mid-write log.

import { listAudit, type RunSummary } from "../../audit/reader.ts";
import type { AuditStore } from "../../audit/store.ts";
import { formatDuration, isStale, jobTiming } from "../../jobs/health.ts";
import type { JobStore } from "../../jobs/store.ts";
import type { JobRecord, LoopJobRecord } from "../../jobs/types.ts";
import type { RunController } from "./controller.ts";
import type { ControlledRun } from "./controller-store.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import { isComplete, type Run, readySteps } from "./engine.ts";

// A compact per-run line for the overview. Deliberately omits the (possibly
// large) final output and per-step detail: drill into one run with chit_trace,
// or chit_audit_show when audited (the run id IS the audit run id).
export interface RunStatusSummary {
	run_id: string;
	manifest: string;
	complete: boolean;
	// Step ids ready to run now; empty when the run is complete.
	ready: string[];
	// True when this run is being audited cleanly, so chit_audit_show <run_id>
	// has a transcript. Mirrors chit_next's audit pointer.
	audited: boolean;
}

export function summarizeRunForStatus(run: Run): RunStatusSummary {
	const complete = isComplete(run);
	return {
		run_id: run.runId,
		manifest: run.manifest.id,
		complete,
		ready: complete ? [] : readySteps(run),
		audited: run.recorder !== undefined && run.recorder.lastError === undefined,
	};
}

// A compact per-loop line for the overview, presented under run_id with the
// unified verbs (a foreground loop's run_id IS its loop-log key; the key never
// surfaces as a separate handle). Iteration detail lives in the loop log; drill in
// with chit_trace.
export interface LoopStatusSummary {
	run_id: string;
	scope: string;
	status: string; // running | open | converged | blocked | max-iterations | cancelled
	iterationsCompleted: number;
	cancellable: boolean;
	lastVerdict?: ConvergeSession["lastVerdict"];
	auditRefs: string[];
	nextAction: string;
}

export function summarizeLoopForStatus(session: ConvergeSession): LoopStatusSummary {
	const stopped = session.terminalStatus !== undefined;
	const status = session.terminalStatus ?? (session.active ? "running" : "open");
	const nextAction = stopped
		? `loop ${session.terminalStatus}; chit_trace "${session.loopId}" for the history`
		: session.active
			? `iteration in flight; chit_cancel "${session.loopId}" to stop it`
			: `chit_next "${session.loopId}" to run the next iteration; chit_cancel "${session.loopId}" to stop`;
	return {
		run_id: session.loopId,
		scope: session.scope,
		status,
		iterationsCompleted: session.iteration,
		cancellable: !stopped,
		...(session.lastVerdict !== undefined && { lastVerdict: session.lastVerdict }),
		auditRefs: session.auditRefs,
		nextAction,
	};
}

// An audit run re-presented for the unified surface: identified by run_id (the
// audit run id IS a run id), with the internal loop-log key (loopId) dropped. The
// receipt names iteration (a number) and status, never a second handle. Shared by
// the chit_status `recent` slice and the chit_audit_* tools so the MCP surface is
// run_id-only; the raw RunSummary (with loopId) stays for the CLI audit command.
export interface PublicRunSummary {
	run_id: string;
	manifestId: string;
	surface: string;
	scope?: string;
	iteration?: number;
	startedAt?: string;
	status: string;
	stepCount: number;
	usage?: RunSummary["usage"];
	openCall?: RunSummary["openCall"];
}

// Strip the per-event run/loop handles from an audit timeline for the MCP surface:
// every audit event carries runId (redundant -- the whole chit_audit_show is one
// run, identified once by the summary's run_id), and run.started / loop-iteration
// events also carry loopId. No row should present a second handle.
export function publicTimeline(timeline: readonly unknown[]): unknown[] {
	return timeline.map((e) => {
		if (e === null || typeof e !== "object") return e;
		const {
			runId: _runId,
			loopId: _loopId,
			...rest
		} = e as {
			runId?: unknown;
			loopId?: unknown;
			[k: string]: unknown;
		};
		void _runId;
		void _loopId;
		return rest;
	});
}

export function publicRunSummary(s: RunSummary): PublicRunSummary {
	return {
		run_id: s.runId,
		manifestId: s.manifestId,
		surface: s.surface,
		...(s.scope !== undefined && { scope: s.scope }),
		...(s.iteration !== undefined && { iteration: s.iteration }),
		...(s.startedAt !== undefined && { startedAt: s.startedAt }),
		status: s.status,
		stepCount: s.stepCount,
		...(s.usage !== undefined && { usage: s.usage }),
		...(s.openCall !== undefined && { openCall: s.openCall }),
	};
}

// A compact per-job line for the overview. `display` derives stale (a running job
// whose worker is gone or silent) so a dead worker is visible without rewriting
// the stored state. Iteration detail (changed files, usage) lives in the loop log;
// drill in with chit_status / chit_trace / chit_audit_show.
export interface JobStatusSummary {
	run_id: string;
	scope: string;
	display: JobRecord["state"] | "stale";
	phase?: JobRecord["phase"];
	// Loop-only fields: a one-shot background run has no loop identity, no
	// iterations, and no convergence verdict. Present iff policy === "loop". The
	// internal loop-log key is NOT surfaced (the run_id is the only handle).
	task?: string;
	iterationsCompleted?: number;
	lastVerdict?: LoopJobRecord["lastVerdict"];
	stopStatus?: LoopJobRecord["stopStatus"];
	auditRefs: string[];
	createdAt: string;
	// Programmatic timing (omitted when not derivable; see jobTiming).
	elapsedMs?: number;
	lastHeartbeatAgeMs?: number;
	phaseElapsedMs?: number;
	nextAction: string;
}

// Running-job nextAction prose: name the phase and how long the job (and the
// current phase) have been going, so a long job is legible at a glance instead
// of a bare "in progress". Falls back to "in progress" when no timing is known.
function runningNextAction(job: JobRecord, timing: ReturnType<typeof jobTiming>): string {
	const parts: string[] = [];
	if (timing.elapsedMs !== undefined) parts.push(`running for ${formatDuration(timing.elapsedMs)}`);
	if (job.phase) {
		parts.push(
			timing.phaseElapsedMs !== undefined
				? `${job.phase} for ${formatDuration(timing.phaseElapsedMs)}`
				: job.phase,
		);
	}
	const lead = parts.length > 0 ? parts.join(", ") : "in progress";
	return `${lead}; chit_status / chit_cancel "${job.runId}"`;
}

function summarizeJobForStatus(job: JobRecord, nowMs: number): JobStatusSummary {
	const stale = isStale(job, nowMs);
	const display = stale ? "stale" : job.state;
	const timing = jobTiming(job, nowMs);
	// Only point at a transcript when one actually exists; a failed/empty job
	// must not tell the operator to open <ref> that was never recorded.
	const latestRef = job.auditRefs.at(-1);
	// stopStatus is loop-only; a one-shot background run has no convergence stop.
	const stopStatus = job.policy === "loop" ? job.stopStatus : undefined;
	const nextAction =
		display === "running"
			? runningNextAction(job, timing)
			: display === "queued"
				? "queued; the worker is starting"
				: display === "stale"
					? `worker appears dead; chit_status "${job.runId}" to inspect, then start a fresh run`
					: `${display}${stopStatus ? ` (${stopStatus})` : ""}; chit_status "${job.runId}"${latestRef ? ` or chit_audit_show ${latestRef}` : ""}`;
	// Loop-only detail (loopId, task, iterations, verdict, stopStatus) is present
	// only for a loop run; a one-shot background run omits all of it. Spread in
	// place so a loop summary keeps its established field order.
	return {
		run_id: job.runId,
		scope: job.scope ?? "",
		...(job.policy === "loop" && { task: job.task }),
		display,
		...(job.phase !== undefined && { phase: job.phase }),
		...(job.policy === "loop" && { iterationsCompleted: job.iterationsCompleted }),
		...(job.policy === "loop" && job.lastVerdict !== undefined && { lastVerdict: job.lastVerdict }),
		...(job.policy === "loop" && job.stopStatus !== undefined && { stopStatus: job.stopStatus }),
		auditRefs: job.auditRefs,
		createdAt: job.createdAt,
		...(timing.elapsedMs !== undefined && { elapsedMs: timing.elapsedMs }),
		...(timing.lastHeartbeatAgeMs !== undefined && {
			lastHeartbeatAgeMs: timing.lastHeartbeatAgeMs,
		}),
		...(timing.phaseElapsedMs !== undefined && { phaseElapsedMs: timing.phaseElapsedMs }),
		nextAction,
	};
}

export interface ChitStatus {
	active: {
		runs: RunStatusSummary[];
		loops: LoopStatusSummary[];
	};
	// Durable background jobs (cross-session): every in-flight job (queued/running,
	// including stale) plus the most recent terminal ones (capped by recentLimit).
	jobs: JobStatusSummary[];
	recent: PublicRunSummary[];
}

// Newest-first by start time. Sorting by startedAtMs (always set on both Run and
// ConvergeSession) is the truthful recency order and is robust to a reused id:
// converge can restart a loop_id with `force`, but Map#set keeps the original
// insertion slot, so a plain reverse-of-insertion-order would misorder the
// restarted loop. A copy keeps the sort from mutating the store's own array.
function byNewest<T extends { startedAtMs: number }>(items: T[]): T[] {
	return [...items].sort((a, b) => b.startedAtMs - a.startedAtMs);
}

// Read the durable recent slice defensively. A recentLimit of 0 means "none"
// (the tool's documented value), so skip the audit read entirely rather than
// enumerate+read every run only to slice to []. Otherwise an audit I/O failure
// (e.g. an unreadable audit dir, where listRuns()'s readdir throws) must NOT mask
// the active control plane, which is chit_status's primary answer: degrade recent
// to [] and let the dedicated chit_audit_list surface the error. listAudit is
// already robust to a single corrupt/mid-write run log; this guards the
// enumeration around it. The guard lives here, not in listAudit, so `chit audit
// list` still reports the failure loudly.
function recentRuns(auditStore: AuditStore, recentLimit: number): RunSummary[] {
	if (recentLimit === 0) return [];
	try {
		return listAudit(auditStore, recentLimit);
	} catch {
		return [];
	}
}

// Assemble the overview. `recentLimit` caps the durable history slice (newest
// first; 0 omits it). Active runs and loops are returned newest-first, each under
// its run_id with the unified verbs (chit_next/chit_cancel/chit_trace).
export function buildStatus(
	controller: RunController,
	auditStore: AuditStore,
	jobStore: JobStore,
	recentLimit: number,
	nowMs: number,
): ChitStatus {
	// One foreground store now holds both kinds (run_id-keyed); split by kind to
	// keep the same two-section overview. byNewest sorts each by startedAtMs, so
	// the output is identical to the pre-merge two-store assembly.
	const fg = controller.foregroundRuns();
	const runs = fg.filter(
		(c): c is Extract<ControlledRun, { kind: "one-shot" }> => c.kind === "one-shot",
	);
	const loops = fg.filter((c): c is Extract<ControlledRun, { kind: "loop" }> => c.kind === "loop");
	return {
		active: {
			runs: byNewest(runs.map((c) => c.run)).map(summarizeRunForStatus),
			loops: byNewest(loops.map((c) => c.session)).map(summarizeLoopForStatus),
		},
		jobs: jobsForStatus(jobStore, recentLimit, nowMs),
		recent: recentRuns(auditStore, recentLimit).map(publicRunSummary),
	};
}

// Durable jobs for the overview: never hide in-flight work (all queued/running,
// stale included), then the most recent terminal jobs capped by recentLimit.
// JobStore.list() is newest-first and skips corrupt files; guard the whole read so
// a jobs I/O failure never masks the rest of the overview.
function jobsForStatus(jobStore: JobStore, recentLimit: number, nowMs: number): JobStatusSummary[] {
	let all: JobRecord[];
	try {
		all = jobStore.list();
	} catch {
		return [];
	}
	const inFlight = all.filter((j) => j.state === "queued" || j.state === "running");
	const terminal = all
		.filter((j) => j.state !== "queued" && j.state !== "running")
		.slice(0, recentLimit);
	return [...inFlight, ...terminal].map((j) => summarizeJobForStatus(j, nowMs));
}
