import type { LoopStopStatus, LoopVerdict } from "@chit-run/core";

// A background run: a detached worker executing one run to completion. The job
// record is the durable source of truth for the JOB (lifecycle, worker identity,
// cancellation intent), keyed by the ONE public id, runId (== the run_id the user
// holds). It SUMMARIZES and POINTS, never duplicating transcripts (audit store,
// via auditRefs) or, for a loop run, the iteration detail the loop log owns.
//
// JobRecord is a DISCRIMINATED UNION on `policy`. Background is a durability mode,
// not converge-only: a one-shot run executes a manifest once; a loop run is the
// implement/check convergence loop. Loop identity and state (loopId, task,
// iterations, verdict, loop stop status, maxIterations) live ONLY on the loop
// variant. A one-shot run has no loop identity, no loop log, no iteration/verdict.
// Pre-public: there is NO back-compat for old jobId/loop-shaped records (the store
// skips records that are not a valid runId+policy union).

// queued: record written, worker not yet running. running: worker executing.
// completed: a loop converged (or hit max-iterations), or a one-shot run finished
// ok. cancelled: stopped on a persisted cancel request. failed: the run failed.
// `stale` is NOT a stored state -- it is DERIVED at read time (running, but the
// worker is not alive and the heartbeat is old).
export type JobState = "queued" | "running" | "completed" | "cancelled" | "failed";

// Small, stable phase for "what is it doing right now". starting: worker booting.
// running: a one-shot run's single pass. implementing/reviewing: a loop
// iteration's implement/review step. recording: appending the iteration + audit.
// cancelling: a cancel request was seen and the worker is stopping. Cleared on a
// terminal state.
export type JobPhase =
	| "starting"
	| "running"
	| "implementing"
	| "reviewing"
	| "recording"
	| "cancelling";

export type RunPolicyKind = "one-shot" | "loop";

// Fields every background run carries, regardless of policy.
export interface BaseJobRecord {
	runId: string; // the ONE public id (the user's run_id)
	policy: RunPolicyKind;
	repoKey: string;
	cwd: string;

	state: JobState;
	createdAt: string; // ISO 8601, when the queued record was written
	startedAt?: string; // when the worker transitioned to running
	endedAt?: string; // when it reached a terminal state

	// Worker identity, for liveness that survives PID reuse: a job is "alive" only
	// when its pid responds AND the heartbeat is recent AND the record still
	// carries this worker's token.
	pid?: number;
	pgid?: number;
	workerToken?: string;
	lastHeartbeatAt?: string;

	phase?: JobPhase;
	// When the current phase began (ISO 8601), set on every phase change and
	// cleared with `phase` at a terminal state.
	phaseStartedAt?: string;

	// Cancellation intent, persisted BEFORE any signal so the reason survives a
	// worker restart or stale detection.
	cancelRequestedAt?: string;

	auditRefs: string[]; // audit run ids
	failure?: string; // terminal failure reason
}

// A background convergence loop (the implement/check routine).
export interface LoopJobRecord extends BaseJobRecord {
	policy: "loop";
	loopId: string; // the loop-log key (internal; never the public handle)
	scope: string;
	task: string; // the slice to converge on
	// Absolute converge manifest path, or undefined for the embedded default.
	manifestPath?: string;
	maxIterations: number;
	// Run despite an unenforceable declared permission (the worker rebuilds the
	// run in its own process, so it needs the flag the caller validated against).
	allowUnenforced: boolean;
	iteration?: number; // current (running) or last completed iteration number
	iterationsCompleted: number;
	lastVerdict?: LoopVerdict;
	stopStatus?: LoopStopStatus;
}

// A background one-shot run: a manifest executed once to completion. No loop
// identity, no loop log, no iterations/verdict. Its history is the audit run.
export interface OneShotJobRecord extends BaseJobRecord {
	policy: "one-shot";
	manifestPath: string; // a one-shot run always names a manifest (the task-form default is a LOOP)
	manifestId: string; // for display
	scope?: string;
	// Persisted at enqueue: the worker runs later in a separate process, so caller
	// inputs are stored here (as {} when empty), never reconstructed.
	inputs: Record<string, unknown>;
	audit: boolean;
	// The enqueue-time allow-unenforced decision, persisted so the worker can
	// RE-validate governance (unknown agents, enforcement gaps, per_scope scope) in
	// its own process before running -- closing the window where the manifest file
	// changes between enqueue and the detached run (the loop carries this for the
	// same reason).
	allowUnenforced: boolean;
}

export type JobRecord = LoopJobRecord | OneShotJobRecord;
