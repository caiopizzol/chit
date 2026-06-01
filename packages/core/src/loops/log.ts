// Convergence log: the durable record of a supervised-convergence loop. Written
// by the orchestrator (the Claude Code chat running the supervised-convergence
// skill), NOT derived from chit runs — chit only sees the `check` step, while
// the implement and decide steps live in the chat. Studio reads this to render
// the loop view; it never depends on the MCP server's in-memory RunStore.
//
// Browser-safe: types + validate/serialize/parse only. The node-backed
// append/read (fs) lives in apps/cli. The file is append-only JSONL: a `loop`
// header line, one `iteration` line per round, then a `stop` line. See
// notes/loop-view-v0.md.

import type { AdapterUsage } from "../audit/events.ts";

export type LoopVerdict = "proceed" | "revise" | "block";
export type LoopStopStatus = "converged" | "blocked" | "max-iterations" | "needs-decision";

const VERDICTS: ReadonlySet<string> = new Set(["proceed", "revise", "block"]);
const STOP_STATUSES: ReadonlySet<string> = new Set([
	"converged",
	"blocked",
	"max-iterations",
	"needs-decision",
]);

export interface LoopHeaderRecord {
	type: "loop";
	schema: 1;
	loopId: string;
	scope: string;
	task: string;
	repo: string;
	startedAt: string; // ISO 8601
	maxIterations: number;
}

export interface LoopIterationRecord {
	type: "iteration";
	n: number;
	implementSummary: string;
	changedFiles: string[];
	checksRun: string;
	verdict: LoopVerdict;
	findingCount: number;
	decision: LoopVerdict;
	checkDurationMs: number;
	at: string; // ISO 8601
	detailsRef?: string;
	// Token/cost for the whole iteration: the sum of every adapter call's usage
	// in the run (implement + review). Optional: absent when no call reported
	// usage. Cost is the sum of REPORTED costs only (Claude reports a cost; Codex
	// reports tokens but no cost), so it is a known-cost floor, not a guaranteed
	// total spend. Tokens across providers are a volume signal, not one billing
	// unit. Same shape as the adapter/audit usage so views speak one type.
	usage?: AdapterUsage;
}

export interface LoopStopRecord {
	type: "stop";
	status: LoopStopStatus;
	reason: string;
	iterations: number;
	totalElapsedMs: number;
	endedAt: string; // ISO 8601
}

export type LoopRecord = LoopHeaderRecord | LoopIterationRecord | LoopStopRecord;

export class LoopLogError extends Error {}

function obj(raw: unknown, ctx: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new LoopLogError(`${ctx}: expected a JSON object`);
	}
	return raw as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, ctx: string): string {
	const v = o[key];
	if (typeof v !== "string" || v === "") {
		throw new LoopLogError(`${ctx}: "${key}" must be a non-empty string`);
	}
	return v;
}

// Counts and durations are non-negative integers; iteration/maxIterations are
// 1-based. Reject negative/fractional so the view never renders nonsense.
function int(o: Record<string, unknown>, key: string, ctx: string, min: number): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
		throw new LoopLogError(`${ctx}: "${key}" must be an integer >= ${min}`);
	}
	return v;
}

function verdict(o: Record<string, unknown>, key: string, ctx: string): LoopVerdict {
	const v = o[key];
	if (typeof v !== "string" || !VERDICTS.has(v)) {
		throw new LoopLogError(`${ctx}: "${key}" must be one of ${[...VERDICTS].join(", ")}`);
	}
	return v as LoopVerdict;
}

function stringArray(o: Record<string, unknown>, key: string, ctx: string): string[] {
	const v = o[key];
	if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
		throw new LoopLogError(`${ctx}: "${key}" must be an array of strings`);
	}
	return v as string[];
}

const USAGE_INT_FIELDS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
] as const;

// Validate an optional usage block, mirroring the AdapterUsage invariants in
// audit/events.ts: token fields are non-negative integers, cost is finite and
// non-negative, and a present block must carry at least one field. Validated
// here (not shared with the audit validator) so this module stays self-contained
// and browser-safe and throws LoopLogError, the same way it already keeps its own
// obj/str/int helpers separate from the audit module's.
function optUsage(o: Record<string, unknown>, ctx: string): AdapterUsage | undefined {
	if (o.usage === undefined) return undefined;
	const u = obj(o.usage, `${ctx}.usage`);
	const usage: AdapterUsage = {};
	for (const f of USAGE_INT_FIELDS) {
		const v = u[f];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
			throw new LoopLogError(`${ctx}.usage: "${f}" must be an integer >= 0`);
		}
		usage[f] = v;
	}
	const cost = u.estimatedCostUsd;
	if (cost !== undefined) {
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
			throw new LoopLogError(`${ctx}.usage: "estimatedCostUsd" must be a finite number >= 0`);
		}
		usage.estimatedCostUsd = cost;
	}
	if (Object.keys(usage).length === 0) {
		throw new LoopLogError(`${ctx}.usage: must have at least one field`);
	}
	return usage;
}

// Validate a single parsed record. Defensive: the writer should emit valid
// records, but Studio reads files that may be hand-edited, partial, or stale.
export function validateLoopRecord(raw: unknown): LoopRecord {
	const o = obj(raw, "record");
	const type = o.type;
	if (type === "loop") {
		const ctx = "loop record";
		if (o.schema !== 1) throw new LoopLogError(`${ctx}: "schema" must be 1`);
		return {
			type: "loop",
			schema: 1,
			loopId: str(o, "loopId", ctx),
			scope: str(o, "scope", ctx),
			task: str(o, "task", ctx),
			repo: str(o, "repo", ctx),
			startedAt: str(o, "startedAt", ctx),
			maxIterations: int(o, "maxIterations", ctx, 1),
		};
	}
	if (type === "iteration") {
		const ctx = "iteration record";
		const rec: LoopIterationRecord = {
			type: "iteration",
			n: int(o, "n", ctx, 1),
			implementSummary: str(o, "implementSummary", ctx),
			changedFiles: stringArray(o, "changedFiles", ctx),
			checksRun: str(o, "checksRun", ctx),
			verdict: verdict(o, "verdict", ctx),
			findingCount: int(o, "findingCount", ctx, 0),
			decision: verdict(o, "decision", ctx),
			checkDurationMs: int(o, "checkDurationMs", ctx, 0),
			at: str(o, "at", ctx),
		};
		if (o.detailsRef !== undefined) rec.detailsRef = str(o, "detailsRef", ctx);
		const usage = optUsage(o, ctx);
		if (usage !== undefined) rec.usage = usage;
		return rec;
	}
	if (type === "stop") {
		const ctx = "stop record";
		const status = o.status;
		if (typeof status !== "string" || !STOP_STATUSES.has(status)) {
			throw new LoopLogError(`${ctx}: "status" must be one of ${[...STOP_STATUSES].join(", ")}`);
		}
		return {
			type: "stop",
			status: status as LoopStopStatus,
			reason: str(o, "reason", ctx),
			iterations: int(o, "iterations", ctx, 0),
			totalElapsedMs: int(o, "totalElapsedMs", ctx, 0),
			endedAt: str(o, "endedAt", ctx),
		};
	}
	throw new LoopLogError(`record: unknown type ${JSON.stringify(type)}`);
}

// Serialize one record to a single JSONL line (no trailing newline). Validates
// first so a malformed record never reaches the file.
export function serializeLoopRecord(rec: LoopRecord): string {
	return JSON.stringify(validateLoopRecord(rec));
}

// Parse a full JSONL log body into records, in file order. Blank lines are
// skipped (a trailing newline is normal). Throws LoopLogError on a line that is
// not valid JSON or not a valid record, naming the 1-based line number.
export function parseLoopLog(body: string): LoopRecord[] {
	const records: LoopRecord[] = [];
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			throw new LoopLogError(`line ${i + 1}: invalid JSON: ${(e as Error).message}`);
		}
		try {
			records.push(validateLoopRecord(parsed));
		} catch (e) {
			throw new LoopLogError(`line ${i + 1}: ${(e as Error).message}`);
		}
	}
	return records;
}

// Validate a full log's structure, beyond per-record validity: exactly one
// `loop` header and it comes first; at most one `stop` and it comes last;
// everything between is an `iteration`. The writer guarantees this by
// construction; a reader (Studio) calls this before trusting records[0] is the
// header. An in-progress log (no `stop` yet) is valid. Kept separate from
// parseLoopLog so a mid-write file can still be parsed line by line.
export function validateLoopLog(records: LoopRecord[]): LoopRecord[] {
	if (records.length === 0) throw new LoopLogError("log: empty");
	if (records[0]?.type !== "loop") {
		throw new LoopLogError("log: first record must be a loop header");
	}
	let stopAt = -1;
	for (let i = 0; i < records.length; i++) {
		const t = records[i]?.type;
		if (t === "loop" && i !== 0) {
			throw new LoopLogError(`log: unexpected second loop header at record ${i + 1}`);
		}
		if (t === "stop") {
			if (stopAt !== -1) {
				throw new LoopLogError(
					`log: more than one stop record (records ${stopAt + 1} and ${i + 1})`,
				);
			}
			stopAt = i;
		}
	}
	if (stopAt !== -1 && stopAt !== records.length - 1) {
		throw new LoopLogError(
			`log: stop record must be last (found at record ${stopAt + 1} of ${records.length})`,
		);
	}
	const end = stopAt === -1 ? records.length : stopAt;
	for (let i = 1; i < end; i++) {
		if (records[i]?.type !== "iteration") {
			throw new LoopLogError(`log: record ${i + 1} must be an iteration`);
		}
	}
	// Cross-record consistency: iteration numbers are sequential 1..N, and a
	// stop's iteration count matches the records actually present. The writer
	// produces these; the reader (Studio) rejects a file that contradicts them
	// rather than rendering nonsense totals.
	const iterations = records.filter((r): r is LoopIterationRecord => r.type === "iteration");
	iterations.forEach((it, k) => {
		if (it.n !== k + 1) {
			throw new LoopLogError(
				`log: iteration numbers must be sequential 1..N (record ${k + 1} has n=${it.n})`,
			);
		}
	});
	if (stopAt !== -1) {
		const stopRec = records[stopAt] as LoopStopRecord;
		if (stopRec.iterations !== iterations.length) {
			throw new LoopLogError(
				`log: stop.iterations=${stopRec.iterations} but the log has ${iterations.length} iteration record(s)`,
			);
		}
	}
	return records;
}
