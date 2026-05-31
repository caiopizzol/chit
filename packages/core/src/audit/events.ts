// Audit event schema: the foundation of chit's run-audit / instrumentation
// substrate. A discriminated union of events emitted across a run's lifecycle
// (run -> step -> adapter call -> loop iteration), serialized as append-only
// JSONL. Studio reads this to render the run timeline; metrics derive from it.
//
// Design: inspection-first but metrics-friendly. Fields a metric needs
// (durationMs, status, verdict, decision, findingCount, token usage, cost) are
// TYPED. Large bodies (full prompt / output / raw adapter event streams) are NOT
// inlined: they are referenced by a BLOB REF (an opaque token naming the blob
// file). The store writes the body; the event only carries the reference.
//
// Browser-safe: types + validate/serialize/parse only. No node:* imports. The
// node-backed audit store (fs, blob writing, retention) lives in apps/cli and
// is a later slice. This module is the SCHEMA ONLY.

// An opaque reference to a blob the store writes (today a sha256 hex digest, but
// the schema does not constrain the format: the store owns the naming scheme).
// The event carries only this reference so the JSONL line stays small.
export type BlobRef = string;

export type AuditSurface = "cli" | "mcp" | "converge";
export type StepKind = "call" | "format";
export type AuditVerdict = "proceed" | "revise" | "block";
// Adapter call outcome vs. whole-run outcome differ by one label: a single call
// can "error", a run "failed". Kept as distinct enums on purpose.
export type AdapterCallStatus = "ok" | "error" | "cancelled" | "timeout";
export type RunStatus = "ok" | "failed" | "cancelled" | "timeout";

const SURFACES: ReadonlySet<string> = new Set(["cli", "mcp", "converge"]);
const STEP_KINDS: ReadonlySet<string> = new Set(["call", "format"]);
const VERDICTS: ReadonlySet<string> = new Set(["proceed", "revise", "block"]);
const ADAPTER_CALL_STATUSES: ReadonlySet<string> = new Set(["ok", "error", "cancelled", "timeout"]);
const RUN_STATUSES: ReadonlySet<string> = new Set(["ok", "failed", "cancelled", "timeout"]);

// Every event carries this envelope: which run, and when (ISO 8601).
interface AuditEnvelope {
	runId: string;
	ts: string;
}

export interface RunStartedEvent extends AuditEnvelope {
	type: "run.started";
	manifestId: string;
	cwd: string;
	surface: AuditSurface;
	loopId?: string;
	iteration?: number;
	manifestPath?: string;
	scope?: string;
	commandArgs?: string[];
}

export interface StepStartedEvent extends AuditEnvelope {
	type: "step.started";
	stepId: string;
	kind: StepKind;
	participantId?: string;
	agentId?: string;
	session?: string;
}

export interface AdapterCallStartedEvent extends AuditEnvelope {
	type: "adapter.call.started";
	stepId: string;
	participantId: string;
	agentId: string;
	cwd: string;
	inputBlob: BlobRef;
	priorSessionRef?: string;
}

interface AdapterEventBase extends AuditEnvelope {
	type: "adapter.event";
	stepId: string;
	eventType: string;
}

// An adapter.event must carry at least one inspectable body: a rawBlob (raw
// event body) or an inline note. The union forbids the neither case at the type
// level; validateAuditEvent enforces the same rule at runtime.
export type AdapterEventEvent = AdapterEventBase &
	({ rawBlob: BlobRef; note?: string } | { rawBlob?: BlobRef; note: string });

// Token/cost accounting for one adapter call. Every field is optional: adapters
// report different subsets (Claude surfaces input/output/cache tokens + a cost;
// Codex surfaces token_count without a cost), and a call that errors early may
// report nothing. If `usage` is present it must carry at least one field — an
// empty block is just noise, the same rule adapter.event uses for its body.
export interface AdapterUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
	estimatedCostUsd?: number;
}

// One-line usage summary, shared by the CLI audit reader and the Studio audit
// view so the two never drift. Pure (browser-safe). Cost is labelled a reported
// floor, since not every provider reports one (Codex does not).
export function formatAdapterUsage(usage: AdapterUsage | undefined): string {
	if (!usage) return "usage: none reported";
	const parts: string[] = [];
	if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
	if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
	if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens}`);
	if (usage.reasoningTokens !== undefined) parts.push(`reasoning ${usage.reasoningTokens}`);
	if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
	if (parts.length === 0 && usage.estimatedCostUsd === undefined) return "usage: none reported";
	const tokens = parts.length > 0 ? `tokens: ${parts.join(", ")}` : "tokens: none";
	const cost =
		usage.estimatedCostUsd !== undefined
			? `; reported cost: $${usage.estimatedCostUsd.toFixed(4)}`
			: "";
	return `${tokens}${cost}`;
}

export interface AdapterCallCompletedEvent extends AuditEnvelope {
	type: "adapter.call.completed";
	stepId: string;
	outputBlob: BlobRef;
	durationMs: number;
	status: AdapterCallStatus;
	newSessionRef?: string;
	exitCode?: number;
	usage?: AdapterUsage;
}

export interface StepCompletedEvent extends AuditEnvelope {
	type: "step.completed";
	stepId: string;
	durationMs: number;
	// The step's output, as a blob ref. Captured for EVERY step so the audit is a
	// full replay, not just an agent-call transcript: a format step (e.g. the run's
	// final output assembly) has no adapter call, so this is the only place its
	// output is recorded. For a call step the output equals the adapter's, and
	// since blobs are content-addressed the two refs point at the same blob.
	// Optional: a writer that does not have the output may omit it.
	outputBlob?: BlobRef;
}

export interface StepFailedEvent extends AuditEnvelope {
	type: "step.failed";
	stepId: string;
	error: string;
	durationMs: number;
}

export interface LoopIterationRecordedEvent extends AuditEnvelope {
	type: "loop.iteration.recorded";
	loopId: string;
	n: number;
	verdict: AuditVerdict;
	decision: AuditVerdict;
	findingCount: number;
	changedFiles: string[];
	checksRun: string;
	// Mirrors LoopIterationRecord.checkDurationMs (loops/log.ts): how long the
	// review/check took. Carried here so the audit timeline is metric-complete
	// without joining back to the loop log.
	checkDurationMs: number;
}

export interface RunCompletedEvent extends AuditEnvelope {
	type: "run.completed";
	status: RunStatus;
	durationMs: number;
}

export type AuditEvent =
	| RunStartedEvent
	| StepStartedEvent
	| AdapterCallStartedEvent
	| AdapterEventEvent
	| AdapterCallCompletedEvent
	| StepCompletedEvent
	| StepFailedEvent
	| LoopIterationRecordedEvent
	| RunCompletedEvent;

export class AuditEventError extends Error {}

function obj(raw: unknown, ctx: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new AuditEventError(`${ctx}: expected a JSON object`);
	}
	return raw as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, ctx: string): string {
	const v = o[key];
	if (typeof v !== "string" || v === "") {
		throw new AuditEventError(`${ctx}: "${key}" must be a non-empty string`);
	}
	return v;
}

function optStr(o: Record<string, unknown>, key: string, ctx: string): string | undefined {
	if (o[key] === undefined) return undefined;
	return str(o, key, ctx);
}

// Counts and durations are non-negative integers. Reject negative/fractional so
// the timeline and any derived metric never render nonsense.
function int(o: Record<string, unknown>, key: string, ctx: string, min: number): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
		throw new AuditEventError(`${ctx}: "${key}" must be an integer >= ${min}`);
	}
	return v;
}

function optInt(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
	min: number,
): number | undefined {
	if (o[key] === undefined) return undefined;
	return int(o, key, ctx, min);
}

// A finite, non-negative number (not required to be an integer). Used for cost,
// which is fractional. Rejects NaN/Infinity so a metric never sums to nonsense.
function optNum(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
	min: number,
): number | undefined {
	if (o[key] === undefined) return undefined;
	const v = o[key];
	if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
		throw new AuditEventError(`${ctx}: "${key}" must be a finite number >= ${min}`);
	}
	return v;
}

const USAGE_INT_FIELDS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
] as const;

// Parse an optional usage block. Token counts are non-negative integers; cost is
// a non-negative fractional number. If usage is present it must carry at least
// one field (an empty block is meaningless), mirroring adapter.event's body rule.
function optUsage(o: Record<string, unknown>, ctx: string): AdapterUsage | undefined {
	if (o.usage === undefined) return undefined;
	const u = obj(o.usage, `${ctx}.usage`);
	const usage: AdapterUsage = {};
	for (const f of USAGE_INT_FIELDS) {
		const v = optInt(u, f, `${ctx}.usage`, 0);
		if (v !== undefined) usage[f] = v;
	}
	const cost = optNum(u, "estimatedCostUsd", `${ctx}.usage`, 0);
	if (cost !== undefined) usage.estimatedCostUsd = cost;
	if (Object.keys(usage).length === 0) {
		throw new AuditEventError(`${ctx}.usage: must have at least one usage field`);
	}
	return usage;
}

function enumVal<T extends string>(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
	allowed: ReadonlySet<string>,
): T {
	const v = o[key];
	if (typeof v !== "string" || !allowed.has(v)) {
		throw new AuditEventError(`${ctx}: "${key}" must be one of ${[...allowed].join(", ")}`);
	}
	return v as T;
}

function stringArray(o: Record<string, unknown>, key: string, ctx: string): string[] {
	const v = o[key];
	if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
		throw new AuditEventError(`${ctx}: "${key}" must be an array of strings`);
	}
	return v as string[];
}

function optStringArray(
	o: Record<string, unknown>,
	key: string,
	ctx: string,
): string[] | undefined {
	if (o[key] === undefined) return undefined;
	return stringArray(o, key, ctx);
}

// Validate a single parsed event. Defensive: the writer should emit valid
// events, but Studio reads files that may be hand-edited, partial, or stale.
export function validateAuditEvent(raw: unknown): AuditEvent {
	const o = obj(raw, "event");
	const type = o.type;
	// Common envelope on every event.
	const runId = str(o, "runId", "event");
	const ts = str(o, "ts", "event");

	if (type === "run.started") {
		const ctx = "run.started";
		const ev: RunStartedEvent = {
			type,
			runId,
			ts,
			manifestId: str(o, "manifestId", ctx),
			cwd: str(o, "cwd", ctx),
			surface: enumVal<AuditSurface>(o, "surface", ctx, SURFACES),
		};
		const loopId = optStr(o, "loopId", ctx);
		if (loopId !== undefined) ev.loopId = loopId;
		// 1-based, matching loop.iteration.recorded.n and the loop log. Omit the
		// field entirely when the run is not part of a loop.
		const iteration = optInt(o, "iteration", ctx, 1);
		if (iteration !== undefined) ev.iteration = iteration;
		const manifestPath = optStr(o, "manifestPath", ctx);
		if (manifestPath !== undefined) ev.manifestPath = manifestPath;
		const scope = optStr(o, "scope", ctx);
		if (scope !== undefined) ev.scope = scope;
		const commandArgs = optStringArray(o, "commandArgs", ctx);
		if (commandArgs !== undefined) ev.commandArgs = commandArgs;
		return ev;
	}

	if (type === "step.started") {
		const ctx = "step.started";
		const ev: StepStartedEvent = {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			kind: enumVal<StepKind>(o, "kind", ctx, STEP_KINDS),
		};
		const participantId = optStr(o, "participantId", ctx);
		if (participantId !== undefined) ev.participantId = participantId;
		const agentId = optStr(o, "agentId", ctx);
		if (agentId !== undefined) ev.agentId = agentId;
		const session = optStr(o, "session", ctx);
		if (session !== undefined) ev.session = session;
		return ev;
	}

	if (type === "adapter.call.started") {
		const ctx = "adapter.call.started";
		const ev: AdapterCallStartedEvent = {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			participantId: str(o, "participantId", ctx),
			agentId: str(o, "agentId", ctx),
			cwd: str(o, "cwd", ctx),
			inputBlob: str(o, "inputBlob", ctx),
		};
		const priorSessionRef = optStr(o, "priorSessionRef", ctx);
		if (priorSessionRef !== undefined) ev.priorSessionRef = priorSessionRef;
		return ev;
	}

	if (type === "adapter.event") {
		const ctx = "adapter.event";
		const rawBlob = optStr(o, "rawBlob", ctx);
		const note = optStr(o, "note", ctx);
		// At least one inspectable body is required: a neither-field event carries
		// no reference and no note, so it is useless to inspect or audit.
		if (rawBlob === undefined && note === undefined) {
			throw new AuditEventError(`${ctx}: must have at least one of "rawBlob" or "note"`);
		}
		const base: AdapterEventBase = {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			eventType: str(o, "eventType", ctx),
		};
		return rawBlob !== undefined
			? { ...base, rawBlob, ...(note !== undefined && { note }) }
			: { ...base, note: note as string };
	}

	if (type === "adapter.call.completed") {
		const ctx = "adapter.call.completed";
		const ev: AdapterCallCompletedEvent = {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			outputBlob: str(o, "outputBlob", ctx),
			durationMs: int(o, "durationMs", ctx, 0),
			status: enumVal<AdapterCallStatus>(o, "status", ctx, ADAPTER_CALL_STATUSES),
		};
		const newSessionRef = optStr(o, "newSessionRef", ctx);
		if (newSessionRef !== undefined) ev.newSessionRef = newSessionRef;
		const exitCode = optInt(o, "exitCode", ctx, 0);
		if (exitCode !== undefined) ev.exitCode = exitCode;
		const usage = optUsage(o, ctx);
		if (usage !== undefined) ev.usage = usage;
		return ev;
	}

	if (type === "step.completed") {
		const ctx = "step.completed";
		const ev: StepCompletedEvent = {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			durationMs: int(o, "durationMs", ctx, 0),
		};
		const outputBlob = optStr(o, "outputBlob", ctx);
		if (outputBlob !== undefined) ev.outputBlob = outputBlob;
		return ev;
	}

	if (type === "step.failed") {
		const ctx = "step.failed";
		return {
			type,
			runId,
			ts,
			stepId: str(o, "stepId", ctx),
			error: str(o, "error", ctx),
			durationMs: int(o, "durationMs", ctx, 0),
		};
	}

	if (type === "loop.iteration.recorded") {
		const ctx = "loop.iteration.recorded";
		return {
			type,
			runId,
			ts,
			loopId: str(o, "loopId", ctx),
			n: int(o, "n", ctx, 1),
			verdict: enumVal<AuditVerdict>(o, "verdict", ctx, VERDICTS),
			decision: enumVal<AuditVerdict>(o, "decision", ctx, VERDICTS),
			findingCount: int(o, "findingCount", ctx, 0),
			changedFiles: stringArray(o, "changedFiles", ctx),
			checksRun: str(o, "checksRun", ctx),
			checkDurationMs: int(o, "checkDurationMs", ctx, 0),
		};
	}

	if (type === "run.completed") {
		const ctx = "run.completed";
		return {
			type,
			runId,
			ts,
			status: enumVal<RunStatus>(o, "status", ctx, RUN_STATUSES),
			durationMs: int(o, "durationMs", ctx, 0),
		};
	}

	throw new AuditEventError(`event: unknown type ${JSON.stringify(type)}`);
}

// Serialize one event to a single JSONL line (no trailing newline). Validates
// first so a malformed event never reaches the file.
export function serializeAuditEvent(ev: AuditEvent): string {
	return JSON.stringify(validateAuditEvent(ev));
}

// Parse a full JSONL audit log body into events, in file order. Blank lines are
// skipped (a trailing newline is normal). Throws AuditEventError on a line that
// is not valid JSON or not a valid event, naming the 1-based line number.
export function parseAuditLog(body: string): AuditEvent[] {
	const events: AuditEvent[] = [];
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			throw new AuditEventError(`line ${i + 1}: invalid JSON: ${(e as Error).message}`);
		}
		try {
			events.push(validateAuditEvent(parsed));
		} catch (e) {
			throw new AuditEventError(`line ${i + 1}: ${(e as Error).message}`);
		}
	}
	return events;
}
