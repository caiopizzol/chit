import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionKey, SessionStore } from "./types.ts";

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Filesystem-safe: only [a-zA-Z0-9._-], everything else becomes `_`.
function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function entryKey(participantId: string, fingerprint: string): string {
	return `${participantId}--${fingerprint}`;
}

// NUL separator for the filename hash, preserving the original hash input. Built
// with fromCharCode rather than a literal NUL byte so the source stays plain
// ASCII text: a NUL in the file makes git treat it as binary and breaks
// plain-text review.
const HASH_SEP = String.fromCharCode(0);

// Block the current thread for `ms` without an external dependency. save() is
// synchronous (the SessionStore contract returns void), so the lock spin cannot
// await a timer; Atomics.wait is the portable, dependency-free synchronous sleep
// and is permitted on the main thread under Node and Bun.
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Sessions are written and read under ~/.local/state/chit/sessions.
export function defaultSessionDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "sessions");
}

// Tunables for the per-file lock. The retry window (lockRetryMs * lockMaxAttempts)
// bounds how long a save waits for a contended lock before failing loudly. Saves
// are sub-millisecond, so normal contention clears well inside the window; only a
// crashed or wedged holder makes a save reach the limit. Tests override these to
// drive the lock deterministically.
export interface FileSessionStoreOptions {
	lockRetryMs?: number;
	lockMaxAttempts?: number;
}

// A held lock: its file path plus the unique token this process wrote into it.
// The token is what makes reclaim ownership-safe (see acquireLock / releaseLock).
interface LockHandle {
	path: string;
	token: string;
}

// File layout:
//   <baseDir>/<safe-scope>--<safe-manifestId>--<hash>.json
//
// `safe-*` are filesystem-sanitized renderings for human discoverability.
// `hash` is sha256(scope + NUL + manifestId), 12 hex chars. The hash makes
// the filename collision-free: two scopes that sanitize to the same string
// (e.g., "foo/bar" and "foo_bar") still produce distinct files.
//
// File contents:
//   { "<participantId>--<fingerprint>": <opaque payload>, ... }
//
// Durability: two `chit` processes sharing the same (scope, manifestId) write
// the SAME file. save() takes a per-file lock across the whole read-modify-write
// so concurrent savers serialize and neither loses the other's entries, and it
// writes via a temp file + rename so a reader never sees a partial file and an
// interrupted write leaves at most a stray .tmp, never a truncated session file.
export class FileSessionStore implements SessionStore {
	private readonly lockRetryMs: number;
	private readonly lockMaxAttempts: number;

	constructor(
		private readonly baseDir: string,
		opts: FileSessionStoreOptions = {},
	) {
		this.lockRetryMs = opts.lockRetryMs ?? 50;
		this.lockMaxAttempts = opts.lockMaxAttempts ?? 200;
	}

	load(key: SessionKey): unknown | undefined {
		const path = this.filePath(key);
		if (!existsSync(path)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return undefined;
		}
		if (!isObject(raw)) return undefined;
		return raw[entryKey(key.participantId, key.fingerprint)];
	}

	save(key: SessionKey, payload: unknown): void {
		const path = this.filePath(key);
		mkdirSync(dirname(path), { recursive: true });

		const lock = this.acquireLock(path);
		try {
			let data: Record<string, unknown> = {};
			if (existsSync(path)) {
				try {
					const raw = JSON.parse(readFileSync(path, "utf-8"));
					if (isObject(raw)) data = raw;
				} catch {
					data = {};
				}
			}
			data[entryKey(key.participantId, key.fingerprint)] = payload;

			// Atomic write: serialize to a unique temp file in the same directory,
			// then rename into place. rename is atomic on one filesystem, so a
			// concurrent reader sees either the old or new file, never a partial one.
			const tmpPath = `${path}.${randomUUID()}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(data, null, 2));
			try {
				// Re-check ownership immediately before publishing. We never auto-reclaim
				// by age, but an operator clearing a presumed-stale lock (or any other
				// external removal) could let another writer take it while we were slow;
				// renaming our now-stale `data` would clobber that newer writer. Abort
				// instead, leaving the newer file in place.
				this.assertOwned(lock);
				renameSync(tmpPath, path);
			} catch (err) {
				rmSync(tmpPath, { force: true });
				throw err;
			}
		} finally {
			this.releaseLock(lock);
		}
	}

	// Acquire the per-file lock by creating `<file>.lock` with O_EXCL ("wx"), which
	// fails atomically if another holder already has it. We write a unique token
	// into the lock so ownership is verifiable: the pre-publish check and release
	// both key off it. On contention we spin with a bounded delay, then fail loudly.
	//
	// We deliberately do NOT auto-reclaim by age. Deciding a lock is "stale" and
	// deleting it is itself a race: a fresh holder can slot in between the staleness
	// check and the delete, and a paused-then-resumed holder can still publish stale
	// data, which is exactly the lost-update class this lock exists to prevent. Saves
	// are sub-millisecond, so a lock held past the retry window means a crashed or
	// wedged holder; we surface that loudly and let the operator clear it rather than
	// racing to reclaim it.
	private acquireLock(path: string): LockHandle {
		const lockPath = `${path}.lock`;
		const token = randomUUID();
		for (let attempt = 0; attempt < this.lockMaxAttempts; attempt++) {
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
				sleepSync(this.lockRetryMs);
			}
		}
		throw new Error(
			`session store: could not acquire lock ${lockPath} after ${this.lockMaxAttempts} attempts. ` +
				"If no chit process is using this scope, a previous run may have crashed while holding it; " +
				`remove the lock file to continue: rm ${JSON.stringify(lockPath)}`,
		);
	}

	// Throw if this process no longer owns the lock (file gone, or rewritten with a
	// different token by a writer that acquired it after an external removal).
	private assertOwned(lock: LockHandle): void {
		let current: string | undefined;
		try {
			current = readFileSync(lock.path, "utf-8");
		} catch {
			current = undefined;
		}
		if (current !== lock.token) {
			throw new Error(
				`session store: lost lock ${lock.path} before write (reclaimed by another process); aborting to avoid overwriting newer data`,
			);
		}
	}

	private releaseLock(lock: LockHandle): void {
		// Only remove the lock if we still own it. An external removal followed by
		// another writer re-acquiring may have replaced it with that writer's lock
		// (its own token); deleting that would strip a live holder's protection. Best
		// effort: if the lock is already gone, nothing to do.
		try {
			if (readFileSync(lock.path, "utf-8") === lock.token) {
				rmSync(lock.path, { force: true });
			}
		} catch {
			// Lock already removed (e.g. reclaimed by another process). Nothing to do.
		}
	}

	private filePath(key: SessionKey): string {
		const readable = `${safeSegment(key.scope)}--${safeSegment(key.manifestId)}`;
		const hash = createHash("sha256")
			.update(`${key.scope}${HASH_SEP}${key.manifestId}`)
			.digest("hex")
			.slice(0, 12);
		return join(this.baseDir, `${readable}--${hash}.json`);
	}
}
