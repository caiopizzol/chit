// Node-backed writer for the convergence log. The supervised-convergence
// orchestrator (the Claude Code chat) calls this once per loop step to append to
// the loop log. The log lives under the state dir, namespaced by repo key (see
// location.ts) -- NOT inside the reviewed repo, so chit's own bookkeeping never
// pollutes the converge reviewer's git diff or the reported changedFiles. The
// pure record model and validation live in @chit-run/core; this adds the
// filesystem and the write-time INVARIANTS the reader cannot retrofit:
//
//   - the repo's loop dir under the state dir is created; loopId is a safe slug.
//   - start refuses to overwrite an existing log unless `force`.
//   - append refuses once a stop record exists.
//   - append computes the next iteration number itself (sequential, 1-based);
//     the caller never supplies `n`.
//   - stop computes `iterations` from the existing records and `totalElapsedMs`
//     from the header's startedAt; the caller supplies neither.
//   - the whole existing log is parsed + structurally validated before every
//     write, so a corrupt/inconsistent file fails loudly instead of growing.
//
// decision is kept distinct from verdict: the policy is that Claude verifies
// Codex, so Claude may proceed despite a `revise`. The store records both and
// never forces them to match.
//
// Concurrency: SINGLE-WRITER. start/append/stop do an unlocked read-then-write,
// so this is correct only when one orchestrator drives a given loop serially
// (the supervised-convergence path: one chat, one loop at a time). Two processes
// appending to the same log could interleave; add a lock before any multi-writer
// use.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AdapterUsage,
	type LoopHeaderRecord,
	type LoopIterationRecord,
	type LoopRecord,
	type LoopStopRecord,
	type LoopStopStatus,
	type LoopVerdict,
	parseLoopLog,
	serializeLoopRecord,
	validateLoopLog,
} from "@chit-run/core";
import { loopLogDir, repoKey, repoRoot } from "./location.ts";

export class LoopStoreError extends Error {}

// A loopId becomes a filename in the repo's loop dir, so constrain it: no path
// separators, no traversal, no dotfiles.
const SAFE_LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type Clock = () => number; // epoch milliseconds

const realClock: Clock = () => Date.now();

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function safeId(loopId: string): string {
	if (!SAFE_LOOP_ID.test(loopId)) {
		throw new LoopStoreError(`invalid loop id ${JSON.stringify(loopId)}`);
	}
	return loopId;
}

// The state-dir path chit reads and writes for a loop.
function loopPath(cwd: string, loopId: string): string {
	return join(loopLogDir(cwd), `${safeId(loopId)}.jsonl`);
}

// Read + structurally validate an existing log before any mutation. Throws a
// clean error for a missing log rather than leaking a raw fs ENOENT.
function readRecords(path: string, loopId: string): LoopRecord[] {
	if (!existsSync(path)) {
		throw new LoopStoreError(`no loop log for ${JSON.stringify(loopId)} at ${path}`);
	}
	const records = validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")));
	// validateLoopLog guarantees records[0] is the header. Bind it to the
	// requested id so a renamed or mismatched file fails loudly instead of
	// being silently used.
	const header = records[0] as LoopHeaderRecord;
	if (header.loopId !== loopId) {
		throw new LoopStoreError(
			`loop log at ${path} declares loopId ${JSON.stringify(header.loopId)}, expected ${JSON.stringify(loopId)}`,
		);
	}
	return records;
}

export interface StartOptions {
	scope: string;
	task: string;
	maxIterations: number;
	loopId?: string; // default: generated
	force?: boolean;
	clock?: Clock;
}

export function startLoop(cwd: string, opts: StartOptions): { loopId: string; path: string } {
	const loopId = opts.loopId ?? crypto.randomUUID();
	const path = loopPath(cwd, loopId);
	if (existsSync(path) && !opts.force) {
		throw new LoopStoreError(`loop log already exists at ${path} (pass force to overwrite)`);
	}
	mkdirSync(loopLogDir(cwd), { recursive: true });
	const header: LoopHeaderRecord = {
		type: "loop",
		schema: 1,
		loopId,
		scope: opts.scope,
		task: opts.task,
		// The resolved repo root (git top-level or canonical cwd) and its key: the
		// log lives at <state>/chit/loops/<repoKey>/<loopId>.jsonl, not in the repo.
		repo: repoRoot(cwd),
		repoKey: repoKey(cwd),
		startedAt: iso((opts.clock ?? realClock)()),
		maxIterations: opts.maxIterations,
	};
	// Fresh file (truncates on force); serializeLoopRecord validates first.
	writeFileSync(path, `${serializeLoopRecord(header)}\n`);
	return { loopId, path };
}

export interface AppendOptions {
	implementSummary: string;
	changedFiles: string[];
	// Non-task workspace conditions (e.g. an untracked generated artifact) worth
	// operator/reviewer attention. Optional; omitted when the workspace was clean.
	workspaceWarnings?: string[];
	checksRun: string;
	verdict: LoopVerdict;
	findingCount: number;
	decision: LoopVerdict;
	checkDurationMs: number;
	auditRef?: string;
	usage?: AdapterUsage;
	clock?: Clock;
}

export function appendIteration(
	cwd: string,
	loopId: string,
	opts: AppendOptions,
): { n: number; path: string } {
	const path = loopPath(cwd, loopId);
	const records = readRecords(path, loopId);
	if (records.some((r) => r.type === "stop")) {
		throw new LoopStoreError(`loop ${JSON.stringify(loopId)} is already stopped; cannot append`);
	}
	// Store-owned, sequential, 1-based. The caller does not supply n.
	const header = records[0] as LoopHeaderRecord;
	const n = records.filter((r) => r.type === "iteration").length + 1;
	if (n > header.maxIterations) {
		throw new LoopStoreError(
			`loop ${JSON.stringify(loopId)} is at its iteration budget (maxIterations=${header.maxIterations}); cannot append iteration ${n}`,
		);
	}
	const rec: LoopIterationRecord = {
		type: "iteration",
		n,
		implementSummary: opts.implementSummary,
		changedFiles: opts.changedFiles,
		checksRun: opts.checksRun,
		verdict: opts.verdict,
		findingCount: opts.findingCount,
		decision: opts.decision,
		checkDurationMs: opts.checkDurationMs,
		at: iso((opts.clock ?? realClock)()),
	};
	if (opts.workspaceWarnings !== undefined && opts.workspaceWarnings.length > 0) {
		rec.workspaceWarnings = opts.workspaceWarnings;
	}
	if (opts.auditRef !== undefined) rec.auditRef = opts.auditRef;
	if (opts.usage !== undefined) rec.usage = opts.usage;
	appendFileSync(path, `${serializeLoopRecord(rec)}\n`);
	return { n, path };
}

export interface StopOptions {
	status: LoopStopStatus;
	reason: string;
	clock?: Clock;
}

export function stopLoop(
	cwd: string,
	loopId: string,
	opts: StopOptions,
): { iterations: number; totalElapsedMs: number; path: string } {
	const path = loopPath(cwd, loopId);
	const records = readRecords(path, loopId);
	if (records.some((r) => r.type === "stop")) {
		throw new LoopStoreError(`loop ${JSON.stringify(loopId)} is already stopped`);
	}
	// validateLoopLog guarantees records[0] is the header.
	const header = records[0] as LoopHeaderRecord;
	const iterations = records.filter((r) => r.type === "iteration").length;
	const nowMs = (opts.clock ?? realClock)();
	const totalElapsedMs = Math.max(0, nowMs - Date.parse(header.startedAt));
	const rec: LoopStopRecord = {
		type: "stop",
		status: opts.status,
		reason: opts.reason,
		iterations,
		totalElapsedMs,
		endedAt: iso(nowMs),
	};
	appendFileSync(path, `${serializeLoopRecord(rec)}\n`);
	return { iterations, totalElapsedMs, path };
}

export function readLoop(cwd: string, loopId: string): LoopRecord[] {
	return readRecords(loopPath(cwd, loopId), loopId);
}
