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

// Programmatic timing for an operator view, so long-running jobs are legible
// without diffing ISO timestamps by hand. All fields are omitted when not
// derivable (no startedAt yet, no heartbeat, no active phase), so callers spread
// the result and only present fields appear in the output JSON.
export interface JobTiming {
	// Wall time the job has been alive: started->now for an in-flight job,
	// started->ended for a terminal one. Falls back to createdAt when the worker
	// never recorded a startedAt (e.g. a job that died queued).
	elapsedMs?: number;
	// Age of the last heartbeat (now - lastHeartbeatAt). Only meaningful while the
	// job is in flight, so it is omitted for terminal jobs even if a heartbeat is
	// on record.
	lastHeartbeatAgeMs?: number;
	// How long the job has been in its current phase (now - phaseStartedAt). Only
	// present when a phase is active (cleared at terminal states).
	phaseElapsedMs?: number;
}

export function jobTiming(job: JobRecord, nowMs: number): JobTiming {
	const inFlight = job.state === "queued" || job.state === "running";
	const timing: JobTiming = {};

	const startMs = Date.parse(job.startedAt ?? job.createdAt);
	const endMs = job.endedAt ? Date.parse(job.endedAt) : nowMs;
	if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
		timing.elapsedMs = endMs - startMs;
	}

	if (inFlight && job.lastHeartbeatAt) {
		const beat = Date.parse(job.lastHeartbeatAt);
		if (Number.isFinite(beat) && nowMs >= beat) timing.lastHeartbeatAgeMs = nowMs - beat;
	}

	if (job.phase !== undefined && job.phaseStartedAt) {
		const phaseStart = Date.parse(job.phaseStartedAt);
		if (Number.isFinite(phaseStart) && nowMs >= phaseStart) {
			timing.phaseElapsedMs = nowMs - phaseStart;
		}
	}

	return timing;
}

// Compact human duration ("45s", "3m12s", "1h4m") for operator-facing nextAction
// strings. Sub-second rounds down to "0s"; the largest two units are shown.
export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) {
		const sec = totalSec % 60;
		return sec ? `${totalMin}m${sec}s` : `${totalMin}m`;
	}
	const hours = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return min ? `${hours}h${min}m` : `${hours}h`;
}
