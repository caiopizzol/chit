import type { LoopStopStatus, LoopVerdict } from "@chit-run/core";

// A background converge job: a detached worker advancing one converge loop. The
// job record is the durable source of truth for the JOB (its lifecycle, the
// worker's identity, cancellation intent). It SUMMARIZES and POINTS, never
// duplicating the iteration detail that the loop log owns or the transcript that
// the audit store owns: iteration changedFiles/workspaceWarnings/verdict are read
// from the loop log (via loopId); transcripts from the audit store (via auditRefs).

// queued: record written, worker not yet running. running: worker advancing the
// loop. completed: reviewer converged (or max-iterations). cancelled: stopped on
// a persisted cancel request. failed: a manifest run failed. `stale` is NOT a
// stored state in v1 -- it is DERIVED at read time (running, but the worker is not
// alive and the heartbeat is old), so a dead worker is surfaced for inspection
// without a reconciler silently rewriting state.
export type JobState = "queued" | "running" | "completed" | "cancelled" | "failed";

// Small, stable phase for "what is it doing right now". starting: worker booting.
// implementing/reviewing: the current iteration's implement/review step (from the
// run's trace). recording: appending the iteration + audit. cancelling: a cancel
// request was seen and the worker is stopping. Cleared on a terminal state.
export type JobPhase = "starting" | "implementing" | "reviewing" | "recording" | "cancelling";

export interface JobRecord {
	jobId: string;
	loopId: string;
	repoKey: string;
	cwd: string;
	scope: string;
	task: string;
	// Absolute converge manifest path, or undefined for the embedded default.
	manifestPath?: string;
	maxIterations: number;
	// Whether to run despite an unenforceable declared permission. The worker
	// rebuilds the execute in its own process, so it needs the same flag the
	// caller validated against.
	allowUnenforced: boolean;

	state: JobState;
	createdAt: string; // ISO 8601, when chit_converge_run wrote the queued record
	startedAt?: string; // when the worker transitioned to running
	endedAt?: string; // when it reached a terminal state

	// Worker identity, for liveness that survives PID reuse: a job is "alive" only
	// when its pid responds AND the heartbeat is recent AND the record still
	// carries this worker's token (a reused pid belongs to a different process that
	// never wrote this token / heartbeat).
	pid?: number;
	pgid?: number;
	workerToken?: string;
	lastHeartbeatAt?: string;

	phase?: JobPhase;
	// When the current phase began (ISO 8601), set on every phase change and
	// cleared with `phase` at a terminal state. Lets a reader report how long the
	// job has been in its current phase (phaseElapsedMs) without guessing.
	phaseStartedAt?: string;
	iteration?: number; // current (running) or last completed iteration number

	// Cancellation intent, persisted BEFORE any signal so the reason survives a
	// worker restart or stale detection.
	cancelRequestedAt?: string;

	// Summary pointers (not the source of truth):
	iterationsCompleted: number;
	lastVerdict?: LoopVerdict;
	auditRefs: string[]; // audit run ids, one per audited iteration

	// Terminal detail:
	stopStatus?: LoopStopStatus;
	failure?: string;
}
