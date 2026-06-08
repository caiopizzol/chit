// Intent-first background-job cancellation, shared by chit_cancel, the batch
// engine's cancelJob, and the Studio host-injected cancel action so all three
// cancel a background job identically.
//
// The queued/running vs terminal decision is made INSIDE the locked
// JobStore.update callback, against the current LOCKED record -- not against an
// earlier unlocked read. A worker that reaches a terminal state concurrently can
// therefore never have cancelRequestedAt stamped onto it, and is never
// re-signaled: the callback returns the record unchanged for any non-live state,
// and the post-write state on the returned record tells us which branch ran.
//
// Persist the intent BEFORE signaling so it survives a worker restart / stale
// detection; a running job also gets phase `cancelling`; a stale or already-exited
// worker is not signaled (its pid may have been reused).

import { isStale, pidAlive } from "./health.ts";
import { type JobStore, JobStoreError } from "./store.ts";
import type { JobRecord } from "./types.ts";

export type CancelResult =
	| { status: "missing" }
	| { status: "terminal"; state: JobRecord["state"] }
	| { status: "requested"; state: "queued" | "running"; signaled: boolean };

export function requestJobCancel(jobStore: JobStore, jobId: string): CancelResult {
	let updated: JobRecord;
	try {
		updated = jobStore.update(jobId, (current) => {
			// Decide against the LOCKED record: only a live job is stamped. A terminal
			// (or otherwise non-live) job is returned without cancel fields, so
			// cancelRequestedAt is never added to a finished run.
			if (current.state !== "queued" && current.state !== "running") return current;
			return {
				...current,
				cancelRequestedAt: new Date().toISOString(),
				...(current.state === "running" && { phase: "cancelling" as const }),
			};
		});
	} catch (e) {
		// update throws only when the record is missing / not a valid union record.
		if (e instanceof JobStoreError) return { status: "missing" };
		throw e;
	}

	// The post-write state is authoritative: a terminal state here means the
	// callback hit the no-op branch (the job finished before/at the lock), so we
	// neither claim a cancel nor signal it.
	if (updated.state !== "queued" && updated.state !== "running") {
		return { status: "terminal", state: updated.state };
	}

	let signaled = false;
	if (!isStale(updated, Date.now()) && updated.pgid !== undefined && pidAlive(updated.pid)) {
		try {
			process.kill(-updated.pgid, "SIGTERM");
			signaled = true;
		} catch {
			// ESRCH: the worker already exited. The persisted intent still stands.
		}
	}
	return { status: "requested", state: updated.state, signaled };
}
