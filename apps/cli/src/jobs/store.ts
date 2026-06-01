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
import { withFileLock } from "./lock.ts";
import type { JobRecord } from "./types.ts";

export class JobStoreError extends Error {}

// A jobId becomes a filename, so constrain it: no separators, traversal, dotfiles.
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Jobs live under ~/.local/state/chit/jobs (XDG-aware), with loop locks beside
// them under jobs/locks. Mirrors the audit and loops state dirs.
export function defaultJobsDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "jobs");
}

export class JobStore {
	constructor(private readonly baseDir: string = defaultJobsDir()) {}

	private path(jobId: string): string {
		if (!SAFE_JOB_ID.test(jobId))
			throw new JobStoreError(`invalid job id ${JSON.stringify(jobId)}`);
		return join(this.baseDir, `${jobId}.json`);
	}

	private lockPath(jobId: string): string {
		return `${this.path(jobId)}.lock`;
	}

	// The loop lock path for a loopId: one advancer (foreground or background) per
	// loop. Lives beside the jobs so it is in the same state tree.
	loopLockPath(loopId: string): string {
		if (!SAFE_JOB_ID.test(loopId))
			throw new JobStoreError(`invalid loop id ${JSON.stringify(loopId)}`);
		mkdirSync(join(this.baseDir, "locks"), { recursive: true });
		return join(this.baseDir, "locks", `${loopId}.lock`);
	}

	// Write a brand-new job record. Refuses to clobber an existing job id.
	create(record: JobRecord): void {
		mkdirSync(this.baseDir, { recursive: true });
		const path = this.path(record.jobId);
		withFileLock(this.lockPath(record.jobId), () => {
			if (existsSync(path))
				throw new JobStoreError(`job ${JSON.stringify(record.jobId)} already exists`);
			writeAtomic(path, record);
		});
	}

	get(jobId: string): JobRecord | undefined {
		const path = this.path(jobId);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as JobRecord;
		} catch {
			return undefined;
		}
	}

	// Read-modify-write a job under its lock. `mutate` receives the current record
	// and returns the next one; the write is atomic. Throws if the job is missing.
	update(jobId: string, mutate: (current: JobRecord) => JobRecord): JobRecord {
		const path = this.path(jobId);
		return withFileLock(this.lockPath(jobId), () => {
			if (!existsSync(path)) throw new JobStoreError(`no job ${JSON.stringify(jobId)}`);
			const current = JSON.parse(readFileSync(path, "utf-8")) as JobRecord;
			const next = mutate(current);
			writeAtomic(path, next);
			return next;
		});
	}

	// All jobs, newest-created first. Skips any unreadable/corrupt file so one bad
	// record never breaks the operator overview.
	list(): JobRecord[] {
		if (!existsSync(this.baseDir)) return [];
		const jobs: JobRecord[] = [];
		for (const name of readdirSync(this.baseDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				jobs.push(JSON.parse(readFileSync(join(this.baseDir, name), "utf-8")) as JobRecord);
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
