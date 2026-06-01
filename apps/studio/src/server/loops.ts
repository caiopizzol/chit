// Server-side read path for the convergence log (notes/loop-view-v0.md). Studio
// reads .chit/loops/<loopId>.jsonl under the invocation cwd and serves loop
// summaries plus a single loop's records. The browser only ever sees the
// safe-slug loopId, never a filesystem path (same rule as the docId table for
// manifests). Read-only: Studio never writes the log; the orchestrator's
// `chit loop-log` owns writes. Parsing/validation reuse the shared @chit/core
// contract, so a file that violates it is rejected here too.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LoopLogError, type LoopRecord, parseLoopLog, validateLoopLog } from "@chit/core";
import type { LoopSummary } from "./types.ts";

export type { LoopSummary };

const SAFE_LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function loopsDir(cwd: string): string {
	return join(cwd, ".chit", "loops");
}

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

// List loop summaries under cwd, newest-started first. Each file is read through
// readLoop, so the same guards apply: a file whose basename is not a safe slug,
// or whose header loopId disagrees with the filename, is skipped (never
// surfaced), as is one that fails to parse/validate. The per-loop route reports
// the specific error for a given id.
export function listLoops(cwd: string): LoopSummary[] {
	const dir = loopsDir(cwd);
	if (!existsSync(dir)) return [];
	const summaries: LoopSummary[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const loopId = name.slice(0, -".jsonl".length);
		const result = readLoop(cwd, loopId);
		if (result.kind === "ok") summaries.push(summarize(loopId, result.records));
	}
	summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return summaries;
}

export type ReadLoopResult =
	| { kind: "ok"; records: LoopRecord[] }
	| { kind: "not-found" }
	| { kind: "invalid-id" }
	| { kind: "invalid-log"; message: string };

// Read one loop's records, distinguishing not-found / bad id / corrupt log so
// the route can choose the right status code.
export function readLoop(cwd: string, loopId: string): ReadLoopResult {
	if (!SAFE_LOOP_ID.test(loopId)) return { kind: "invalid-id" };
	const path = join(loopsDir(cwd), `${loopId}.jsonl`);
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
