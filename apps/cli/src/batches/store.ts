// Durable store for batches: one JSON file per batch under the state dir,
// keyed by repo, written atomically (temp + rename) under a per-file O_EXCL lock.
// Mirrors the JobStore exactly (same lock primitive from jobs/lock.ts), so a
// chit_batch_advance updating task state never races a concurrent reader.
// Batch state lives OUTSIDE the reviewed tree (state dir, not .chit/), per the
// control-plane rule.

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
import { withFileLock } from "../jobs/lock.ts";
import { repoKey } from "../loops/location.ts";
import type { Batch } from "./types.ts";

export class BatchStoreError extends Error {}

const SAFE_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Batches live under <state>/chit/batches/<repoKey>/<id>.json, keyed by the
// same repo hash the loop logs use, so one repo's batches are namespaced apart.
export function batchesDir(cwd: string): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "batches", repoKey(cwd));
}

export class BatchStore {
	// `cwd` is any path inside the target repo; repoKey resolves it to the repo
	// namespace (so a batch started from a subdir lands in the same place).
	constructor(private readonly cwd: string) {}

	private dir(): string {
		return batchesDir(this.cwd);
	}

	private path(id: string): string {
		if (!SAFE_BATCH_ID.test(id)) {
			throw new BatchStoreError(`invalid batch id ${JSON.stringify(id)}`);
		}
		return join(this.dir(), `${id}.json`);
	}

	private lockPath(id: string): string {
		return `${this.path(id)}.lock`;
	}

	create(batch: Batch): void {
		mkdirSync(this.dir(), { recursive: true });
		const path = this.path(batch.id);
		withFileLock(this.lockPath(batch.id), () => {
			if (existsSync(path)) {
				throw new BatchStoreError(`batch ${JSON.stringify(batch.id)} already exists`);
			}
			writeAtomic(path, batch);
		});
	}

	get(id: string): Batch | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as Batch;
		} catch {
			return undefined;
		}
	}

	// Read-modify-write under the lock. `mutate` returns the next batch; the
	// write is atomic. Throws if the batch is missing.
	update(id: string, mutate: (current: Batch) => Batch): Batch {
		const path = this.path(id);
		// Ensure the dir exists so the lock file can be created even when updating a
		// batch that was never created (we then throw the clean not-found below).
		mkdirSync(this.dir(), { recursive: true });
		return withFileLock(this.lockPath(id), () => {
			if (!existsSync(path)) throw new BatchStoreError(`no batch ${JSON.stringify(id)}`);
			const current = JSON.parse(readFileSync(path, "utf-8")) as Batch;
			const next = mutate(current);
			writeAtomic(path, next);
			return next;
		});
	}

	// All batches for this repo, newest-created first; skips corrupt files.
	list(): Batch[] {
		const dir = this.dir();
		if (!existsSync(dir)) return [];
		const out: Batch[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as Batch);
			} catch {
				// skip corrupt/mid-write file
			}
		}
		out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return out;
	}
}

function writeAtomic(path: string, batch: Batch): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(batch, null, 2));
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
