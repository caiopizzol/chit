// Node-backed audit store. Persists one run's audit events and their large
// bodies under ~/.local/state/handoff/audit/runs/<runId>/. The browser-safe
// event schema + validation live in @chit/core (audit/events.ts); this adds the
// filesystem:
//
//   events.jsonl   append-only, one validated AuditEvent per line.
//   blobs/<sha256>  content-addressed bodies (full prompts, outputs, raw event
//                   streams). writeBlob returns the sha256 hex = the BlobRef the
//                   event carries; an event line stays small while the body lives
//                   beside it.
//
// Blobs are per-run, NOT global. Dedup is within a run, but retention can delete
// a whole run directory without refcounting blobs shared across runs (slice 2b).
//
// The store OWNS the blob naming scheme (sha256 hex), which the @chit/core schema
// deliberately leaves opaque. So readBlob validates the ref shape before building
// a path: a crafted ref cannot escape the blobs directory.
//
// Concurrency: appendEvent is a single appendFileSync (atomic for small lines on
// local filesystems); writeBlob is content-addressed and idempotent. Concurrent
// writers to the same run's events.jsonl could still interleave partial lines on
// some filesystems; today one orchestrator drives one run.

import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AuditEvent, type BlobRef, parseAuditLog, serializeAuditEvent } from "@chit/core";

export class AuditStoreError extends Error {}

// A runId becomes a directory name; constrain it: no path separators, no
// traversal, no dotfiles.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// A BlobRef the store produces is a sha256 hex digest: exactly 64 lowercase hex
// chars. readBlob rejects anything else before touching the filesystem.
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type Clock = () => number; // epoch milliseconds

const realClock: Clock = () => Date.now();

// Retention caps for prune(). All optional; a run is removed if ANY cap selects
// it. Recency is the run's newest activity (its last event's ts).
export interface PruneOptions {
	maxAgeMs?: number; // drop runs whose newest activity is older than now - maxAgeMs
	maxRuns?: number; // keep at most this many newest runs
	maxTotalBytes?: number; // keep newest runs whose cumulative size fits under this
	// Run ids that must NEVER be pruned, even if a cap selects them. The caller
	// uses this to protect the run it just wrote (whose own size could exceed
	// maxTotalBytes, or which a misconfigured cap could otherwise delete).
	keep?: readonly string[];
	clock?: Clock;
}

export function defaultAuditDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "handoff", "audit");
}

export class AuditStore {
	constructor(private readonly baseDir: string = defaultAuditDir()) {}

	// Resolve + validate a run's directory. The id check guards every path the
	// store builds, so a malicious or malformed runId never escapes baseDir.
	private runDir(runId: string): string {
		if (!SAFE_RUN_ID.test(runId)) {
			throw new AuditStoreError(`invalid run id ${JSON.stringify(runId)}`);
		}
		return join(this.baseDir, "runs", runId);
	}

	// Ensure a run's directory tree exists. Optional: appendEvent and writeBlob
	// each create what they need, but a run.started handler can call this once.
	openRun(runId: string): string {
		const dir = this.runDir(runId);
		mkdirSync(join(dir, "blobs"), { recursive: true });
		return dir;
	}

	// Write a body and return its content address. Identical bodies map to one
	// blob file (named by their sha256), so a prompt/output referenced by several
	// events is stored once within the run.
	//
	// The write is atomic: the body goes to a unique temp file, then renames into
	// place. So a reader never sees a partial blob, and an interrupted write
	// (e.g. a watchdog-killed process) cannot leave a truncated file under the
	// content address. We always rename into place rather than skip-if-exists, so
	// a stale or partial prior attempt is overwritten with the correct content.
	writeBlob(runId: string, body: string): BlobRef {
		const blobsDir = join(this.runDir(runId), "blobs");
		mkdirSync(blobsDir, { recursive: true });
		const ref = createHash("sha256").update(body).digest("hex");
		const tmpPath = join(blobsDir, `${ref}.${randomUUID()}.tmp`);
		writeFileSync(tmpPath, body);
		renameSync(tmpPath, join(blobsDir, ref));
		return ref;
	}

	readBlob(runId: string, ref: BlobRef): string {
		if (!SHA256_HEX.test(ref)) {
			throw new AuditStoreError(`invalid blob ref ${JSON.stringify(ref)}`);
		}
		const path = join(this.runDir(runId), "blobs", ref);
		if (!existsSync(path)) {
			throw new AuditStoreError(`no blob ${ref} for run ${JSON.stringify(runId)}`);
		}
		return readFileSync(path, "utf-8");
	}

	// Append one event. Binds the event to this run (a mismatched runId is a
	// programming error and fails loudly). serializeAuditEvent validates the
	// event BEFORE any filesystem side effect, so a malformed event neither lands
	// in the file nor creates a phantom run directory.
	appendEvent(runId: string, event: AuditEvent): void {
		if (event.runId !== runId) {
			throw new AuditStoreError(
				`event.runId ${JSON.stringify(event.runId)} does not match run ${JSON.stringify(runId)}`,
			);
		}
		const line = serializeAuditEvent(event);
		const dir = this.runDir(runId);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "events.jsonl"), `${line}\n`);
	}

	readEvents(runId: string): AuditEvent[] {
		const path = join(this.runDir(runId), "events.jsonl");
		if (!existsSync(path)) {
			throw new AuditStoreError(`no audit log for run ${JSON.stringify(runId)} at ${path}`);
		}
		return parseAuditLog(readFileSync(path, "utf-8"));
	}

	// Run ids present in the store, in arbitrary order. Skips non-directories and
	// any stray name that isn't a safe run id.
	listRuns(): string[] {
		const runsDir = join(this.baseDir, "runs");
		if (!existsSync(runsDir)) return [];
		return readdirSync(runsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && SAFE_RUN_ID.test(e.name))
			.map((e) => e.name);
	}

	// A run's newest activity, as epoch ms: the ts of its last recorded event. A
	// run with no readable events (event-less, mid-creation, or corrupt log)
	// falls back to its directory mtime so prune still has a recency to compare.
	private recencyMs(runId: string): number {
		const dir = this.runDir(runId);
		const logPath = join(dir, "events.jsonl");
		if (existsSync(logPath)) {
			try {
				const events = parseAuditLog(readFileSync(logPath, "utf-8"));
				const last = events[events.length - 1];
				// The schema validates ts as a non-empty string, not a real date, so a
				// schema-valid but unparseable ts is possible. Use mtime if it does not
				// parse, so an unparseable ts never produces a NaN recency that silently
				// escapes age pruning.
				if (last) {
					const parsed = Date.parse(last.ts);
					if (Number.isFinite(parsed)) return parsed;
				}
			} catch {
				// Corrupt/partial log: fall through to mtime.
			}
		}
		return statSync(dir).mtimeMs;
	}

	// Total bytes on disk for a run (events.jsonl + every blob).
	private runSizeBytes(runId: string): number {
		const dir = this.runDir(runId);
		if (!existsSync(dir)) return 0;
		let total = 0;
		const walk = (p: string): void => {
			for (const e of readdirSync(p, { withFileTypes: true })) {
				const full = join(p, e.name);
				if (e.isDirectory()) walk(full);
				else total += statSync(full).size;
			}
		};
		walk(dir);
		return total;
	}

	// Apply retention caps, deleting whole run directories (events + blobs). A run
	// is pruned if ANY supplied cap selects it. With no caps, prunes nothing.
	// Returns the pruned run ids, newest-first. The size cap keeps the newest runs
	// whose cumulative size fits, so a single run larger than the cap is itself
	// pruned.
	prune(opts: PruneOptions = {}): string[] {
		// Validate every cap BEFORE any deletion: this API removes data, and a bad
		// value (e.g. a negative maxRuns from caller arithmetic) must fail loudly,
		// never silently delete everything. Zero is a valid, intentional cap.
		if (opts.maxRuns !== undefined && (!Number.isInteger(opts.maxRuns) || opts.maxRuns < 0)) {
			throw new AuditStoreError("prune: maxRuns must be a non-negative integer");
		}
		if (opts.maxAgeMs !== undefined && (!Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs < 0)) {
			throw new AuditStoreError("prune: maxAgeMs must be a finite number >= 0");
		}
		if (
			opts.maxTotalBytes !== undefined &&
			(!Number.isFinite(opts.maxTotalBytes) || opts.maxTotalBytes < 0)
		) {
			throw new AuditStoreError("prune: maxTotalBytes must be a finite number >= 0");
		}

		const now = (opts.clock ?? realClock)();
		const runs = this.listRuns().map((id) => ({ id, recency: this.recencyMs(id) }));
		// Newest first; ties broken by id so the order (and thus which runs the
		// size/count caps keep) is deterministic.
		runs.sort((a, b) => b.recency - a.recency || (a.id < b.id ? -1 : 1));

		const doomed = new Set<string>();
		if (opts.maxAgeMs !== undefined) {
			const cutoff = now - opts.maxAgeMs;
			for (const r of runs) if (r.recency < cutoff) doomed.add(r.id);
		}
		if (opts.maxRuns !== undefined) {
			for (const r of runs.slice(Math.max(0, opts.maxRuns))) doomed.add(r.id);
		}
		if (opts.maxTotalBytes !== undefined) {
			let running = 0;
			for (const r of runs) {
				running += this.runSizeBytes(r.id);
				if (running > opts.maxTotalBytes) doomed.add(r.id);
			}
		}

		const keep = new Set(opts.keep ?? []);
		const pruned = runs.filter((r) => doomed.has(r.id) && !keep.has(r.id)).map((r) => r.id);
		for (const id of pruned) rmSync(this.runDir(id), { recursive: true, force: true });
		return pruned;
	}
}
