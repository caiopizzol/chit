// The compact loop status line, shared by every chit surface so they cannot drift.
// chit_next returns it on each iteration response; chit_status recomposes it from the
// in-memory session mirror; Studio recomposes it from the durable loop records. One
// composer behind all three keeps the live, audit, and durable narrations identical.
// Its vocabulary mirrors the heartbeat lines so all of them read the same:
// "iteration N · outcome[ · checks][ · stop]".
//
// Browser-safe: pure string composition over the core loop types, no Node APIs.

import type { LoopCheck, LoopStopStatus, VerificationSource } from "./log.ts";

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
