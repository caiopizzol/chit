// Durable store for background converge jobs: one JSON file per job under the
// state dir, written atomically (temp + rename) under a per-file O_EXCL lock so
// the worker's frequent heartbeat updates and a concurrent chit_job_cancel never
// lose each other's writes or expose a partial file. Mirrors FileSessionStore's
// durability model; the lock primitive is shared (jobs/lock.ts).
//
// The JobStore owns the JOB record only. The loop log (loopId) remains the source
// of truth for iterations; the audit store (auditRefs) for transcripts.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeLiveEvents } from "../runtime/live-events.ts";
import { withFileLock } from "./lock.ts";
import type { JobRecord } from "./types.ts";

export class JobStoreError extends Error {}

// A runId becomes a filename, so constrain it: no separators, traversal, dotfiles.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const JOB_STATES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"completed",
	"cancelled",
	"failed",
]);

// A durable record is valid only if it is a complete runId+policy union (the
// current shape). Pre-public, there is NO back-compat for old jobId/loop-shaped
// records: list() skips them and get() treats them as absent, rather than
// coercing a stale shape into the new union.
//
// "Valid" must mean "safe to read": readers (status.ts, the MCP views) are
// documented as never-throwing and dereference base fields (auditRefs.at(-1),
// state) and, after narrowing, variant fields unconditionally. So the guard
// checks the discriminant AND every field a narrowed reader relies on, not just
// runId+policy -- a half-written `{runId, policy}` must NOT pass and then crash a
// reader. `expectedRunId`, when known by the caller, also pins the record to the
// file it came from (runId is the filename), so a renamed/mismatched file reads
// as absent.
function isValidJobRecord(raw: unknown, expectedRunId?: string): raw is JobRecord {
	if (raw === null || typeof raw !== "object") return false;
	const r = raw as Record<string, unknown>;
	if (typeof r.runId !== "string" || !SAFE_RUN_ID.test(r.runId)) return false;
	if (expectedRunId !== undefined && r.runId !== expectedRunId) return false;
	if (r.policy !== "loop" && r.policy !== "one-shot") return false;
	// Base fields every reader dereferences regardless of policy.
	if (typeof r.repoKey !== "string" || typeof r.cwd !== "string") return false;
	if (typeof r.state !== "string" || !JOB_STATES.has(r.state)) return false;
	if (typeof r.createdAt !== "string") return false;
	if (!Array.isArray(r.auditRefs) || !r.auditRefs.every((x) => typeof x === "string")) return false;
	// Variant-required fields the narrowed readers rely on.
	if (r.policy === "loop") {
		return (
			typeof r.loopId === "string" &&
			typeof r.scope === "string" &&
			typeof r.task === "string" &&
			typeof r.maxIterations === "number" &&
			typeof r.iterationsCompleted === "number" &&
			typeof r.allowUnenforced === "boolean"
		);
	}
	return (
		typeof r.manifestPath === "string" &&
		typeof r.manifestId === "string" &&
		typeof r.inputs === "object" &&
		r.inputs !== null &&
		typeof r.audit === "boolean" &&
		typeof r.allowUnenforced === "boolean"
	);
}

// recentEvents is the one job-record field whose entries flow on to display
// surfaces (the live tower, status views), and the file is a trust boundary: it
// may have been written by another worker version or hand-edited. Rebuild the
// tail field-by-field through sanitizeLiveEvents (off-contract keys -- raw,
// prompt, output, ... -- and malformed entries are dropped, the cap re-applied),
// so no reader ever sees an off-contract tail; this mirrors the foreground
// registry's parseSnapshot. A tail with nothing valid left is dropped entirely,
// like a legacy record without the field. Sanitize, never reject: a corrupt
// tail is not worth treating the whole job as invalid.
function withSanitizedTail(record: JobRecord): JobRecord {
	if (record.recentEvents === undefined) return record;
	const events = sanitizeLiveEvents(record.recentEvents);
	return { ...record, recentEvents: events.length > 0 ? events : undefined };
}

// Jobs live under ~/.local/state/chit/jobs (XDG-aware), with loop locks beside
// them under jobs/locks. Mirrors the audit and loops state dirs.
export function defaultJobsDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "jobs");
}

export class JobStore {
	constructor(private readonly baseDir: string = defaultJobsDir()) {}

	private path(runId: string): string {
		if (!SAFE_RUN_ID.test(runId))
			throw new JobStoreError(`invalid run id ${JSON.stringify(runId)}`);
		return join(this.baseDir, `${runId}.json`);
	}

	private lockPath(runId: string): string {
		return `${this.path(runId)}.lock`;
	}

	// The loop lock path for a loopId: one advancer (foreground or background) per
	// loop. Lives beside the jobs so it is in the same state tree. Loop runs only.
	loopLockPath(loopId: string): string {
		if (!SAFE_RUN_ID.test(loopId))
			throw new JobStoreError(`invalid loop id ${JSON.stringify(loopId)}`);
		mkdirSync(join(this.baseDir, "locks"), { recursive: true });
		return join(this.baseDir, "locks", `${loopId}.lock`);
	}

	// Write a brand-new job record. Refuses to clobber an existing run id.
	create(record: JobRecord): void {
		mkdirSync(this.baseDir, { recursive: true });
		const path = this.path(record.runId);
		withFileLock(this.lockPath(record.runId), () => {
			if (existsSync(path))
				throw new JobStoreError(`run ${JSON.stringify(record.runId)} already exists`);
			writeAtomic(path, record);
		});
	}

	// Fetch a run by id. Returns undefined if absent OR not a valid runId+policy
	// record (a stale pre-union file is treated as not found, never coerced).
	get(runId: string): JobRecord | undefined {
		const path = this.path(runId);
		if (!existsSync(path)) return undefined;
		try {
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			return isValidJobRecord(raw, runId) ? withSanitizedTail(raw) : undefined;
		} catch {
			return undefined;
		}
	}

	// Read-modify-write a job under its lock. `mutate` receives the current record
	// and returns the next one; the write is atomic. Throws if the job is missing
	// or not a valid union record.
	update(runId: string, mutate: (current: JobRecord) => JobRecord): JobRecord {
		const path = this.path(runId);
		return withFileLock(this.lockPath(runId), () => {
			if (!existsSync(path)) throw new JobStoreError(`no run ${JSON.stringify(runId)}`);
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (!isValidJobRecord(raw, runId))
				throw new JobStoreError(`run ${JSON.stringify(runId)} is not a valid record`);
			// Sanitize BEFORE mutate: the usual `...current` copy in a mutator must not
			// carry a hand-edited file's off-contract tail entries forward.
			const next = mutate(withSanitizedTail(raw));
			writeAtomic(path, next);
			return next;
		});
	}

	// Atomically apply `mutate` ONLY if the record is still `queued`, under the
	// file lock. Returns true if THIS caller won the claim (the record was queued
	// and is now written), false if it was already claimed, missing, or invalid.
	// This is the serialization point for a worker that shares no other lock: a
	// loop run is serialized by its loop lock, but a one-shot run has none, so two
	// workers spawned for the same job must not both move it past `queued` and run
	// the manifest twice.
	claim(runId: string, mutate: (current: JobRecord) => JobRecord): boolean {
		const path = this.path(runId);
		return withFileLock(this.lockPath(runId), () => {
			if (!existsSync(path)) return false;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				return false;
			}
			if (!isValidJobRecord(raw, runId) || raw.state !== "queued") return false;
			writeAtomic(path, mutate(withSanitizedTail(raw)));
			return true;
		});
	}

	// All jobs, newest-created first. Skips any unreadable/corrupt file AND any
	// stale pre-union record, so one bad file never breaks the operator overview.
	list(): JobRecord[] {
		if (!existsSync(this.baseDir)) return [];
		const jobs: JobRecord[] = [];
		for (const name of readdirSync(this.baseDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const raw: unknown = JSON.parse(readFileSync(join(this.baseDir, name), "utf-8"));
				// Pin the record to its filename: runId IS the file name, so a record
				// whose runId disagrees with the file is corrupt and is skipped.
				const id = name.slice(0, -".json".length);
				if (isValidJobRecord(raw, id)) jobs.push(withSanitizedTail(raw));
			} catch {
				// skip corrupt/mid-write file
			}
		}
		jobs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return jobs;
	}
}

// Serialize to a unique temp file in the same dir, then rename into place. Rename
// is atomic on one filesystem, so a concurrent reader sees the old or new file,
// never a partial one. An interrupted write leaves at most a stray .tmp.
function writeAtomic(path: string, record: JobRecord): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(record, null, 2));
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
