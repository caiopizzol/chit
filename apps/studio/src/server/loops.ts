// Server-side read path for the convergence log. Studio serves loop summaries
// plus a single loop's records. The browser only ever sees the safe-slug loopId,
// never a filesystem path (same rule as the docId table for manifests).
// Read-only: Studio never writes the log; `chit converge` / `chit loop-log` own
// writes. Parsing/validation reuse the shared @chit-run/core contract, so a file
// that violates it is rejected here too.
//
// Loop logs live under the state dir, keyed by repo (see apps/cli loops/
// location.ts). The HOST (the CLI) owns that scheme and INJECTS the resolved
// directory here -- Studio never reimplements the resolver, the same way it is
// handed the audit dir. An absent dir (a standalone Studio with no host) lists
// nothing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LoopLogError, type LoopRecord, parseLoopLog, validateLoopLog } from "@chit-run/core";
import type { LoopSummary } from "./types.ts";

export type { LoopSummary };

const SAFE_LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// loopId is the validated basename (safe-slug, matching the header) supplied by
// the caller, not read back from the header — so a summary can never carry an
// unsafe or mismatched id.
function summarize(loopId: string, records: LoopRecord[]): LoopSummary {
	const header = records[0];
	if (header?.type !== "loop") throw new LoopLogError("log: first record must be a loop header");
	const last = records[records.length - 1];
	const stop = last?.type === "stop" ? last : undefined;
	return {
		loopId,
		scope: header.scope,
		task: header.task,
		status: stop ? stop.status : "in-progress",
		iterations: records.filter((r) => r.type === "iteration").length,
		totalElapsedMs: stop ? stop.totalElapsedMs : null,
		startedAt: header.startedAt,
	};
}

export type ReadLoopResult =
	| { kind: "ok"; records: LoopRecord[] }
	| { kind: "not-found" }
	| { kind: "invalid-id" }
	| { kind: "invalid-log"; message: string };

// Read + validate one loop from a specific directory. Same guards as the writer:
// a file whose header loopId disagrees with the filename, or that fails to
// parse/validate, is reported as invalid-log.
function readLoopFrom(dir: string, loopId: string): ReadLoopResult {
	const path = join(dir, `${loopId}.jsonl`);
	if (!existsSync(path)) return { kind: "not-found" };
	try {
		const records = validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")));
		const header = records[0];
		if (header?.type !== "loop" || header.loopId !== loopId) {
			return { kind: "invalid-log", message: "header loopId does not match the file name" };
		}
		return { kind: "ok", records };
	} catch (e) {
		if (e instanceof LoopLogError) return { kind: "invalid-log", message: e.message };
		throw e;
	}
}

// List loop summaries under the injected dir, newest-started first. A file that
// is not a safe slug, whose header id disagrees, or that fails to validate is
// skipped (never surfaced); the per-loop route reports the specific error. An
// absent dir (no host) lists nothing.
export function listLoops(loopsDir: string | undefined): LoopSummary[] {
	if (!loopsDir || !existsSync(loopsDir)) return [];
	const summaries: LoopSummary[] = [];
	for (const name of readdirSync(loopsDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const loopId = name.slice(0, -".jsonl".length);
		if (!SAFE_LOOP_ID.test(loopId)) continue;
		const result = readLoopFrom(loopsDir, loopId);
		if (result.kind === "ok") summaries.push(summarize(loopId, result.records));
	}
	summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return summaries;
}

// Read one loop's records from the injected dir. Distinguishes not-found / bad
// id / corrupt log so the route can choose the right status code.
export function readLoop(loopsDir: string | undefined, loopId: string): ReadLoopResult {
	if (!SAFE_LOOP_ID.test(loopId)) return { kind: "invalid-id" };
	if (!loopsDir) return { kind: "not-found" };
	return readLoopFrom(loopsDir, loopId);
}
