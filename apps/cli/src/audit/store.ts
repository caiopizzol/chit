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
}
