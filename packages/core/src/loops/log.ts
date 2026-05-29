// Convergence log: the durable record of a supervised-convergence loop. Written
// by the orchestrator (the Claude Code chat running the supervised-convergence
// skill), NOT derived from chit runs — chit only sees the `check` step, while
// the implement and decide steps live in the chat. Studio reads this to render
// the loop view; it never depends on the MCP server's in-memory RunStore.
//
// Browser-safe: types + validate/serialize/parse only. The node-backed
// append/read (fs) lives in apps/cli. The file is append-only JSONL: a `loop`
// header line, one `iteration` line per round, then a `stop` line. See
// docs/loop-view-v0.md.

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
