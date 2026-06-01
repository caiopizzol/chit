// Server-side read path for the audit log (notes/audit-v0.md). Studio reads
// <auditDir>/runs/<runId>/events.jsonl (the local-state store the CLI writes,
// NOT the cwd) and serves a run's events, optionally with the referenced blob
// bodies. Read-only: Studio never writes the audit log. The browser only ever
// sends the safe-slug runId; a blob is only ever read by a sha256 ref already
// present in the validated events, never by a path from the client.
//
// The run-id and blob-ref shapes + the dir resolution mirror
// apps/cli/src/audit/store.ts (which Studio cannot import: apps/cli already
// depends on @chit/studio, so importing it back would be a cycle). Keep the two
// in sync.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AuditEvent, AuditEventError, parseAuditLog } from "@chit/core";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Audited runs live under ~/.local/state/chit/audit. Mirrors apps/cli/src/audit/store.ts.
export function defaultAuditDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "audit");
}

// The blob refs a single event references (prompt, output, raw stream).
function blobRefs(e: AuditEvent): string[] {
	switch (e.type) {
		case "adapter.call.started":
			return [e.inputBlob];
		case "adapter.call.completed":
			return [e.outputBlob];
		case "step.completed":
			return e.outputBlob ? [e.outputBlob] : [];
		case "adapter.event":
			return e.rawBlob ? [e.rawBlob] : [];
		default:
			return [];
	}
}

export type ReadAuditResult =
	| { kind: "ok"; events: AuditEvent[]; blobs?: Record<string, string> }
	| { kind: "not-found" }
	| { kind: "invalid-id" }
	| { kind: "invalid-log"; message: string };

// Read one audit run's events, optionally resolving the referenced blob bodies.
// Distinguishes not-found / bad id / corrupt log so the route picks the status.
// When includeBlobs is set, only refs that appear in the validated events and
// match the sha256 shape are read, so the client can never name an arbitrary file.
export function readAuditRun(
	auditDir: string,
	runId: string,
	includeBlobs: boolean,
): ReadAuditResult {
	if (!SAFE_RUN_ID.test(runId)) return { kind: "invalid-id" };
	const runDir = join(auditDir, "runs", runId);
	const eventsPath = join(runDir, "events.jsonl");
	if (!existsSync(eventsPath)) return { kind: "not-found" };
	let events: AuditEvent[];
	try {
		events = parseAuditLog(readFileSync(eventsPath, "utf-8"));
	} catch (e) {
		if (e instanceof AuditEventError) return { kind: "invalid-log", message: e.message };
		throw e;
	}
	if (!includeBlobs) return { kind: "ok", events };

	const blobsDir = join(runDir, "blobs");
	const blobs: Record<string, string> = {};
	for (const e of events) {
		for (const ref of blobRefs(e)) {
			if (!SHA256_HEX.test(ref) || ref in blobs) continue;
			const blobPath = join(blobsDir, ref);
			if (existsSync(blobPath)) blobs[ref] = readFileSync(blobPath, "utf-8");
		}
	}
	return { kind: "ok", events, blobs };
}
