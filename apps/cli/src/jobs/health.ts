// Liveness + staleness for background jobs. PID reuse is real, so we never trust
// pid liveness alone: a job is "alive" only while its worker's heartbeat stays
// fresh. Staleness is DERIVED at read time (v1 does not persist a `stale` state);
// chit_job_status / chit_status surface it so a dead worker is visible for
// inspection without a reconciler silently rewriting the record.

import type { JobRecord } from "./types.ts";

// How long a running job's heartbeat may lag before it is considered stale. The
// worker heartbeats every ~10s, so a minute of silence means a crashed/wedged
// worker (or a paused machine), not normal operation.
export const STALE_AFTER_MS = 60_000;

// True if a process with this pid currently exists. kill(pid, 0) signals nothing
// but validates existence; EPERM means it exists under another user (still alive).
export function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}

// A job is stale when its worker should be making progress but is not:
//   - running: the worker is gone OR its heartbeat is too old. Heartbeat age is
//     the primary signal (it also covers PID reuse: a reused pid is "alive" but
//     never refreshes THIS job's heartbeat).
//   - queued: the worker never transitioned to running within the window, so the
//     spawn failed silently or the worker crashed at startup (it has no pid yet,
//     so liveness can only be judged by how long it has sat queued).
// Terminal jobs (completed/cancelled/failed) are never stale.
export function isStale(job: JobRecord, nowMs: number, staleAfterMs = STALE_AFTER_MS): boolean {
	if (job.state === "queued") {
		const created = Date.parse(job.createdAt);
		return Number.isFinite(created) && nowMs - created > staleAfterMs;
	}
	if (job.state !== "running") return false;
	const beat = job.lastHeartbeatAt ? Date.parse(job.lastHeartbeatAt) : 0;
	const heartbeatOld = !Number.isFinite(beat) || nowMs - beat > staleAfterMs;
	return heartbeatOld || !pidAlive(job.pid);
}
