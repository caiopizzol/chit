// Convergence log: the durable record of a supervised-convergence loop. Written
// by the orchestrator (the Claude Code chat running the supervised-convergence
// skill), NOT derived from chit runs — chit only sees the `check` step, while
// the implement and decide steps live in the chat. Studio reads this to render
// the loop view; it never depends on the MCP server's in-memory RunStore.
//
// Browser-safe: types + validate/serialize/parse only. The node-backed
// append/read (fs) lives in apps/cli. The file is append-only JSONL: a `loop`
// header line, one `iteration` line per round, then a `stop` line.

import {
	type AdapterUsage,
	type AuditParticipantSnapshot,
	parseAuditParticipantSnapshots,
} from "../audit/events.ts";
import type { ConfigOrigin, RecipeReceipt } from "../config/types.ts";

export type LoopVerdict = "proceed" | "revise" | "block";
export type LoopStopStatus =
	| "converged"
	| "blocked"
	| "max-iterations"
	| "needs-decision"
	| "cancelled";

// Verification is the rollup of an iteration's checks: the signal the loop gates
// `converged` on. "passed" only when every check passed; "failed" when any failed;
// "blocked" when a check could not run (e.g. a read-only sandbox); "not_run" when
// no checks were attempted. A proceed verdict with verification !== "passed" must
// NOT converge clean -- chit never reports success more strongly than the checks
// support. In stage 1 the source is the reviewer's self-reported checks; in stage 2
// it becomes chit-executed required_checks (the same fields, an authoritative source).
export type Verification = "passed" | "failed" | "blocked" | "not_run";

// Where an iteration's `verification` came from: the reviewer's self-reported checks
// (advisory) or commands chit executed itself (ground truth). Recorded so chit_trace
// makes the distinction explicit rather than presenting both as the same `checks`.
export type VerificationSource = "reviewer" | "chit";
// One check behind the checksRun prose. command is the exact command; status is its
// own result; reason explains a non-pass (a failure summary, or why it was blocked).
// The execution-metadata fields below make a chit-executed check auditable -- what ran,
// where, how long, the timeout applied, and how the process exited -- instead of only a
// passed/failed rollup. They are all optional: a reviewer self-report carries none of
// them (chit never invents process metadata for a reviewer's claim), and a log written
// before they existed still parses.
export interface LoopCheck {
	// The exact command as a display string -- for a chit-executed check this is the
	// argv joined ("bun test"), the GROUND TRUTH of what ran; for a reviewer-reported
	// check it is whatever the reviewer claimed it ran. Never a friendly label.
	command: string;
	// Optional friendly label (e.g. "tests"). A convenience for display; it is NEVER a
	// substitute for `command`, which always carries what actually ran.
	name?: string;
	status: "passed" | "failed" | "blocked";
	// For a chit-executed check this is the bounded output tail of a non-pass (a failing
	// command's error tail, or why it was blocked); for a reviewer check it is their
	// self-reported explanation. Absent on a pass.
	reason?: string;
	// The directory the check ran in (the run worktree). Set only for chit-executed
	// checks; the run's repo/worktree path is already public on the loop header.
	cwd?: string;
	// Wall-clock the check took, in milliseconds.
	elapsedMs?: number;
	// The timeout applied to the check, in milliseconds (the configured value, else the
	// default). Present even on a pass, so a slow-but-passing check is still auditable
	// against its budget.
	timeoutMs?: number;
	// The process exit code, present only when the process actually ran (passed/failed);
	// absent when it never started or was killed before exiting (blocked).
	exitCode?: number;
}

const VERDICTS: ReadonlySet<string> = new Set(["proceed", "revise", "block"]);
const VERIFICATIONS: ReadonlySet<string> = new Set(["passed", "failed", "blocked", "not_run"]);
const VERIFICATION_SOURCES: ReadonlySet<string> = new Set(["reviewer", "chit"]);
const CHECK_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "blocked"]);
const STOP_STATUSES: ReadonlySet<string> = new Set([
	"converged",
	"blocked",
	"max-iterations",
	"needs-decision",
	"cancelled",
]);

export interface LoopHeaderRecord {
	type: "loop";
	schema: 1;
	loopId: string;
	scope: string;
	task: string;
	// The repo this loop belongs to: the resolved git top-level path (or the
	// canonical cwd when not a git repo). Human-readable; `repoKey` is its stable
	// hash, used to namespace the loop log under the state dir.
	repo: string;
	// Stable hash of `repo`: the directory key under which this loop's log lives
	// in the state dir.
	repoKey: string;
	startedAt: string; // ISO 8601
	maxIterations: number;
	// Managed-worktree metadata (#100), present only for an isolated write run. They make a
	// CLOSED foreground run recoverable from its durable log -- chit_cleanup / chit_trace resolve
	// the run from these when it is gone from the server's memory. Absent for in_place / pre-0.23
	// logs (recovery then derives what it can from `repo`/git). `repo` (above) is the WORKTREE's
	// own toplevel for a managed run; `mainRepo` is the durable repo cleanup must anchor on, and
	// `callerCheckout` is where chit_apply applies.
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	mainRepo?: string;
	callerCheckout?: string;
	// Execution provenance for a loop run, persisted in the header so a CLOSED foreground
	// run still answers "what ran" from its durable log. Same redacted shape as audit
	// run.started: envKeys only, never env values. Absent on older logs.
	participants?: Record<string, AuditParticipantSnapshot>;
	// The approved config recipe selected for this run, when a plan step used one.
	// Manifest path/digest/participants are surfaced through the normal manifest
	// binding fields elsewhere; this is the named recipe layer the operator approved.
	recipe?: RecipeReceipt;
}

export interface LoopIterationRecord {
	type: "iteration";
	n: number;
	implementSummary: string;
	// Files the agent changed as part of the task (tracked edits + staged + new
	// source). Chit's own control-plane state is never listed here.
	changedFiles: string[];
	// Non-task workspace conditions worth operator/reviewer attention, e.g. an
	// untracked generated artifact the implementer's checks produced. NOT "ignored
	// junk": it is surfaced precisely so it stays visible without polluting
	// changedFiles. Optional and absent when the workspace was clean.
	workspaceWarnings?: string[];
	checksRun: string;
	// Structured check results behind checksRun's prose, and their rollup. Optional:
	// absent on records written before this field existed and when no checks were
	// reported. The loop gates `converged` on verification (see Verification).
	checks?: LoopCheck[];
	verification?: Verification;
	// Where `verification` came from (reviewer self-report vs chit-executed). Absent on
	// records with no verification.
	verificationSource?: VerificationSource;
	verdict: LoopVerdict;
	findingCount: number;
	decision: LoopVerdict;
	checkDurationMs: number;
	at: string; // ISO 8601
	// The audit run id for this iteration's transcript, when the run was audited.
	// Absent for an unaudited iteration.
	auditRef?: string;
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

function verificationOf(o: Record<string, unknown>, key: string, ctx: string): Verification {
	const v = o[key];
	if (typeof v !== "string" || !VERIFICATIONS.has(v)) {
		throw new LoopLogError(`${ctx}: "${key}" must be one of ${[...VERIFICATIONS].join(", ")}`);
	}
	return v as Verification;
}

function verificationSourceOf(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
): VerificationSource {
	const v = o[key];
	if (typeof v !== "string" || !VERIFICATION_SOURCES.has(v)) {
		throw new LoopLogError(
			`${ctx}: "${key}" must be one of ${[...VERIFICATION_SOURCES].join(", ")}`,
		);
	}
	return v as VerificationSource;
}

function checkArray(o: Record<string, unknown>, key: string, ctx: string): LoopCheck[] {
	const v = o[key];
	if (!Array.isArray(v)) throw new LoopLogError(`${ctx}: "${key}" must be an array`);
	return v.map((e, i) => {
		const ec = `${ctx}.${key}[${i}]`;
		if (typeof e !== "object" || e === null) throw new LoopLogError(`${ec}: must be an object`);
		const r = e as Record<string, unknown>;
		if (typeof r.command !== "string" || r.command === "") {
			throw new LoopLogError(`${ec}: "command" must be a non-empty string`);
		}
		if (typeof r.status !== "string" || !CHECK_STATUSES.has(r.status)) {
			throw new LoopLogError(`${ec}: "status" must be one of ${[...CHECK_STATUSES].join(", ")}`);
		}
		const check: LoopCheck = { command: r.command, status: r.status as LoopCheck["status"] };
		if (r.name !== undefined) {
			if (typeof r.name !== "string" || r.name === "")
				throw new LoopLogError(`${ec}: "name" must be a non-empty string`);
			check.name = r.name;
		}
		if (r.reason !== undefined) {
			if (typeof r.reason !== "string") throw new LoopLogError(`${ec}: "reason" must be a string`);
			check.reason = r.reason;
		}
		// Optional chit-execution metadata. Each is validated when present and otherwise
		// absent, so a reviewer self-report and a pre-existing log both parse unchanged.
		if (r.cwd !== undefined) {
			if (typeof r.cwd !== "string" || r.cwd === "")
				throw new LoopLogError(`${ec}: "cwd" must be a non-empty string`);
			check.cwd = r.cwd;
		}
		if (r.elapsedMs !== undefined) {
			if (typeof r.elapsedMs !== "number" || !Number.isInteger(r.elapsedMs) || r.elapsedMs < 0)
				throw new LoopLogError(`${ec}: "elapsedMs" must be an integer >= 0`);
			check.elapsedMs = r.elapsedMs;
		}
		if (r.timeoutMs !== undefined) {
			if (typeof r.timeoutMs !== "number" || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 0)
				throw new LoopLogError(`${ec}: "timeoutMs" must be an integer >= 0`);
			check.timeoutMs = r.timeoutMs;
		}
		if (r.exitCode !== undefined) {
			if (typeof r.exitCode !== "number" || !Number.isInteger(r.exitCode))
				throw new LoopLogError(`${ec}: "exitCode" must be an integer`);
			check.exitCode = r.exitCode;
		}
		return check;
	});
}

function stringArray(o: Record<string, unknown>, key: string, ctx: string): string[] {
	const v = o[key];
	if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
		throw new LoopLogError(`${ctx}: "${key}" must be an array of strings`);
	}
	return v as string[];
}

function configOrigin(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
): ConfigOrigin | undefined {
	if (o[key] === undefined) return undefined;
	const v = obj(o[key], `${ctx}.${key}`);
	const source = v.source;
	if (source !== "builtin" && source !== "global" && source !== "repo") {
		throw new LoopLogError(`${ctx}.${key}: "source" must be builtin, global, or repo`);
	}
	const origin: ConfigOrigin = { source };
	if (v.path !== undefined) origin.path = str(v, "path", `${ctx}.${key}`);
	return origin;
}

function recipeReceipt(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
): RecipeReceipt | undefined {
	if (o[key] === undefined) return undefined;
	const v = obj(o[key], `${ctx}.${key}`);
	const mode = v.mode;
	if (mode !== "converge") {
		throw new LoopLogError(`${ctx}.${key}: "mode" must be converge`);
	}
	const receipt: RecipeReceipt = {
		id: str(v, "id", `${ctx}.${key}`),
		mode,
	};
	const origin = configOrigin(v, "origin", `${ctx}.${key}`);
	if (origin !== undefined) receipt.origin = origin;
	if (v.maxIterations !== undefined) {
		receipt.maxIterations = int(v, "maxIterations", `${ctx}.${key}`, 1);
	}
	if (v.callTimeoutMs !== undefined) {
		receipt.callTimeoutMs = int(v, "callTimeoutMs", `${ctx}.${key}`, 1);
	}
	if (v.description !== undefined) receipt.description = str(v, "description", `${ctx}.${key}`);
	return receipt;
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
		const rec: LoopHeaderRecord = {
			type: "loop",
			schema: 1,
			loopId: str(o, "loopId", ctx),
			scope: str(o, "scope", ctx),
			task: str(o, "task", ctx),
			repo: str(o, "repo", ctx),
			repoKey: str(o, "repoKey", ctx),
			startedAt: str(o, "startedAt", ctx),
			maxIterations: int(o, "maxIterations", ctx, 1),
		};
		// Optional managed-worktree metadata (#100); validated as strings when present. Absent for
		// in_place / pre-0.23 logs.
		if (o.worktreePath !== undefined) rec.worktreePath = str(o, "worktreePath", ctx);
		if (o.branch !== undefined) rec.branch = str(o, "branch", ctx);
		if (o.baseSha !== undefined) rec.baseSha = str(o, "baseSha", ctx);
		if (o.mainRepo !== undefined) rec.mainRepo = str(o, "mainRepo", ctx);
		if (o.callerCheckout !== undefined) rec.callerCheckout = str(o, "callerCheckout", ctx);
		if (o.participants !== undefined) {
			try {
				rec.participants = parseAuditParticipantSnapshots(o.participants, `${ctx}.participants`);
			} catch (e) {
				throw new LoopLogError((e as Error).message);
			}
		}
		const recipe = recipeReceipt(o, "recipe", ctx);
		if (recipe !== undefined) rec.recipe = recipe;
		return rec;
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
		if (o.workspaceWarnings !== undefined) {
			rec.workspaceWarnings = stringArray(o, "workspaceWarnings", ctx);
		}
		if (o.checks !== undefined) rec.checks = checkArray(o, "checks", ctx);
		if (o.verification !== undefined) rec.verification = verificationOf(o, "verification", ctx);
		if (o.verificationSource !== undefined)
			rec.verificationSource = verificationSourceOf(o, "verificationSource", ctx);
		if (o.auditRef !== undefined) rec.auditRef = str(o, "auditRef", ctx);
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
