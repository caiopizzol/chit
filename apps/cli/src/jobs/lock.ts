// O_EXCL file lock with an ownership token, shared by the JobStore (per-job
// read-modify-write) and the loop lock (one advancer per loop, foreground or
// background). Mirrors the proven session-store lock: create `<path>` with
// O_EXCL ("wx") so acquisition fails atomically if a holder exists, write a
// unique token so ownership is verifiable, spin with a bounded delay, then fail
// loudly.
//
// We deliberately do NOT auto-reclaim by age. Deciding a lock is "stale" and
// deleting it is itself a race: a fresh holder can slot in between the check and
// the delete. A lock held past the retry window means a crashed or wedged holder;
// we surface that loudly and let the operator (or stale-job detection) clear it,
// rather than racing to reclaim it.

import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export class LockError extends Error {}

// Synchronous sleep without a dependency (the session store uses the same trick):
// Atomics.wait is the portable, main-thread-safe synchronous wait under Node/Bun.
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LockHandle {
	path: string;
	token: string;
}

export interface LockOptions {
	retryMs?: number;
	maxAttempts?: number;
}

// Acquire the lock at `lockPath`, or throw LockError after the bounded retry
// window. Writes a unique token so the holder can verify ownership before
// releasing (an external removal + re-acquire by another process must not let us
// delete their lock).
export function acquireLock(lockPath: string, opts: LockOptions = {}): LockHandle {
	const retryMs = opts.retryMs ?? 50;
	const maxAttempts = opts.maxAttempts ?? 200;
	const token = randomUUID();
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, token);
			} finally {
				closeSync(fd);
			}
			return { path: lockPath, token };
		} catch (err) {
			if ((err as { code?: string }).code !== "EEXIST") throw err;
			sleepSync(retryMs);
		}
	}
	throw new LockError(
		`could not acquire lock ${lockPath} after ${maxAttempts} attempts. ` +
			"If no chit process holds it, a previous run may have crashed while holding it; " +
			`remove the lock file to continue: rm ${JSON.stringify(lockPath)}`,
	);
}

// True only if we still own the lock (file present and carrying our token).
export function ownsLock(lock: LockHandle): boolean {
	try {
		return readFileSync(lock.path, "utf-8") === lock.token;
	} catch {
		return false;
	}
}

// Release the lock only if we still own it. An external removal followed by
// another writer re-acquiring may have replaced it with that writer's token;
// deleting that would strip a live holder's protection. Best effort.
export function releaseLock(lock: LockHandle): void {
	try {
		if (readFileSync(lock.path, "utf-8") === lock.token) rmSync(lock.path, { force: true });
	} catch {
		// Already removed (e.g. reclaimed by another process). Nothing to do.
	}
}

// Run `fn` while holding the lock, releasing it (if still owned) on the way out.
// For short read-modify-write critical sections (the JobStore); the loop lock is
// held across a whole run via acquire/release directly.
export function withFileLock<T>(lockPath: string, fn: () => T, opts?: LockOptions): T {
	const lock = acquireLock(lockPath, opts);
	try {
		return fn();
	} finally {
		releaseLock(lock);
	}
}
