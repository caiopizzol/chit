// The compact loop status line, shared by every chit surface so they cannot drift.
// chit_next returns it on each iteration response; chit_status recomposes it from the
// in-memory session mirror; Studio recomposes it from the durable loop records. One
// composer behind all three keeps the live, audit, and durable narrations identical.
// Its vocabulary mirrors the heartbeat lines so all of them read the same:
// "iteration N · outcome[ · checks][ · stop]".
//
// Browser-safe: pure string composition over the core loop types, no Node APIs.

import type { AdapterUsage } from "../audit/events.ts";
import type {
	LoopCheck,
	LoopIterationRecord,
	LoopRecord,
	LoopStopRecord,
	LoopStopStatus,
	Verification,
	VerificationSource,
} from "./log.ts";

// A concise check rollup for the status line: "N/M required checks passed" for
// chit-executed checks (ground truth), "N/M checks passed" for the reviewer's
// self-reported ones (advisory) -- the same distinction status.ts draws. Undefined
// when no checks ran (the verdict + stop status already carry the round), so the line
// omits the segment entirely.
export function checkSummary(
	checks: LoopCheck[] | undefined,
	source: VerificationSource | undefined,
): string | undefined {
	if (!checks || checks.length === 0) return undefined;
	const passed = checks.filter((c) => c.status === "passed").length;
	const noun = source === "chit" ? "required checks" : "checks";
	return `${passed}/${checks.length} ${noun} passed`;
}

// The shared composition behind every loop status line: "iteration N · outcome[ · checks][ · stop]".
// chit_next feeds it the transient NextResult; chit_status feeds it the session mirror; Studio feeds
// it the durable loop records. Routing all three through one composer is what keeps the live, audit,
// and durable narrations from drifting.
export function composeLoopStatusLine(parts: {
	iteration: number;
	// The outcome word: a completed round's verdict, or a cancelled/failed round's fate.
	outcome: string;
	// The round's structured checks, or undefined when the round ran none (a cancelled/
	// failed round) -- the rollup is the WHY behind a verification gate stop.
	checks: LoopCheck[] | undefined;
	source: VerificationSource | undefined;
	// The stop status attributed to THIS line's round -- appended when that round took
	// the loop terminal, unless the outcome word already states it (a cancelled round
	// stops "cancelled"). Callers must pass the round's OWN stop, never a later one.
	stop: LoopStopStatus | undefined;
}): string {
	const out = [`iteration ${parts.iteration}`, parts.outcome];
	const checks = checkSummary(parts.checks, parts.source);
	if (checks) out.push(checks);
	if (parts.stop && parts.stop !== parts.outcome) out.push(parts.stop);
	return out.join(" · ");
}

// The run status a receipt reports: the live "open"/"running" of an in-flight loop,
// or the terminal stop status once it settled. Mirrors the engine's ConvergeRunStatus
// so a surface can pass the status it already knows; buildLoopReceipt falls back to the
// stop record (or "open") when a caller has no live status to hand.
export type LoopRunStatus = "open" | "running" | LoopStopStatus;

// A compact, self-contained answer to "what happened?" for one loop run, derived ONLY
// from the durable loop records. It is a companion to the raw records (chit_trace keeps
// both), so an operator or agent reads the outcome without replaying every iteration. It
// re-uses the iteration fields the records already carry and the composeLoopStatusLine
// vocabulary -- it never re-reads config, prompts, blobs, or audits, and it carries no
// prompts, outputs, blob bodies, env values, or participant provenance (those live on
// the surrounding view, not here).
export interface LoopReceipt {
	// open/running while in flight, else the terminal stop status.
	status: LoopRunStatus;
	// Completed iteration records, or the stop record's own count once stopped (the two
	// agree by construction; see validateLoopLog).
	iterationsCompleted: number;
	// The latest completed iteration's compact line, in the composeLoopStatusLine
	// vocabulary. Omitted when no iteration completed (a stopped-zero-iteration run).
	statusLine?: string;
	// Stable de-duplicated union of every iteration's changedFiles, in first-seen order.
	changedFiles: string[];
	// Stable de-duplicated union of every iteration's workspaceWarnings, first-seen order
	// ([] when none, matching the live surfaces that always carry the array).
	workspaceWarnings: string[];
	// The latest iteration's structured checks, when it recorded any.
	latestChecks?: LoopCheck[];
	// The latest iteration's verification rollup + its source, when present.
	verification?: Verification;
	verificationSource?: VerificationSource;
	// Token/cost summed across iterations with the additive semantics converge already
	// uses (per field, absent stays absent; cost is a reported floor). Omitted when no
	// iteration reported usage.
	usage?: AdapterUsage;
	// Each iteration's audit ref, in order (an unaudited iteration contributes none).
	auditRefs: string[];
	// From the stop record, when the run has stopped.
	stopReason?: string;
	elapsedMs?: number;
	endedAt?: string;
}

// Token/cost fields summed across iteration usage blocks, the same set converge sums
// (apps/cli converge sumTraceUsage and the audit reader's sumUsage). Kept local so this
// module stays browser-safe and self-contained, the way log.ts keeps its own usage list.
const USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
	"estimatedCostUsd",
] as const;

function dedupeInOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
}

// Per-field sum of every iteration's usage. Absent fields stay absent (never coerced to
// 0); returns undefined when no iteration reported usage, so the receipt omits the field.
function sumIterationUsage(iterations: LoopIterationRecord[]): AdapterUsage | undefined {
	const usage: AdapterUsage = {};
	let any = false;
	for (const it of iterations) {
		if (!it.usage) continue;
		for (const k of USAGE_KEYS) {
			const v = it.usage[k];
			if (typeof v === "number") {
				usage[k] = (usage[k] ?? 0) + v;
				any = true;
			}
		}
	}
	return any ? usage : undefined;
}

// The stop status the LATEST completed iteration's round itself produced, or undefined
// when the stop does NOT belong to that round (so the status line never mis-attributes a
// terminal). The verdict-driven stops (converged/needs-decision from a proceed decision,
// blocked from a block decision, max-iterations from a revise decision) are produced by
// the round whose record is the log's last -- those correspond. A `cancelled` stop, and a
// `blocked` stop on a non-block decision (a manifest failure in a later, un-recorded
// round), aborted an in-flight round that wrote NO record, so they do not. Mirrors the
// engine's lastStopStatus mirror without re-running the converge gate.
function latestIterationStop(
	latest: LoopIterationRecord,
	stop: LoopStopRecord | undefined,
): LoopStopStatus | undefined {
	if (stop === undefined) return undefined;
	switch (stop.status) {
		case "converged":
		case "needs-decision":
			return latest.decision === "proceed" ? stop.status : undefined;
		case "blocked":
			return latest.decision === "block" ? "blocked" : undefined;
		case "max-iterations":
			return latest.decision === "revise" ? "max-iterations" : undefined;
		case "cancelled":
			return undefined;
	}
}

// Build the compact receipt for a loop run from its durable records alone. A terminal stop
// record is always authoritative for `status`; `status` lets a caller that knows the live
// run state (a foreground session, a background job) report "open"/"running" precisely WHILE
// the log has no stop yet. With neither, an in-progress log reads "open". The records are the
// SINGLE source of truth -- this reads nothing else, so it is browser-safe and reusable
// across the CLI, MCP, and Studio.
export function buildLoopReceipt(records: LoopRecord[], status?: LoopRunStatus): LoopReceipt {
	const iterations = records.filter((r): r is LoopIterationRecord => r.type === "iteration");
	const stop = records.find((r): r is LoopStopRecord => r.type === "stop");
	const latest = iterations.at(-1);
	const usage = sumIterationUsage(iterations);
	const statusLine =
		latest !== undefined
			? composeLoopStatusLine({
					iteration: latest.n,
					// The reviewer's verdict is the outcome word, exactly as the live + session
					// status lines render it; the round's own stop (when it produced one) is appended.
					outcome: latest.verdict,
					checks: latest.checks,
					source: latest.verificationSource,
					stop: latestIterationStop(latest, stop),
				})
			: undefined;
	return {
		status: stop?.status ?? status ?? "open",
		iterationsCompleted: stop ? stop.iterations : iterations.length,
		...(statusLine !== undefined && { statusLine }),
		changedFiles: dedupeInOrder(iterations.flatMap((it) => it.changedFiles)),
		workspaceWarnings: dedupeInOrder(iterations.flatMap((it) => it.workspaceWarnings ?? [])),
		...(latest?.checks !== undefined && { latestChecks: latest.checks }),
		...(latest?.verification !== undefined && { verification: latest.verification }),
		...(latest?.verificationSource !== undefined && {
			verificationSource: latest.verificationSource,
		}),
		...(usage !== undefined && { usage }),
		auditRefs: iterations.flatMap((it) => (it.auditRef !== undefined ? [it.auditRef] : [])),
		...(stop !== undefined && {
			stopReason: stop.reason,
			elapsedMs: stop.totalElapsedMs,
			endedAt: stop.endedAt,
		}),
	};
}
