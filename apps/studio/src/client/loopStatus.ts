// Recompose the compact "last completed iteration" status line for the loop view
// from the DURABLE loop records, using the shared @chit-run/core composer
// (composeLoopStatusLine) -- the SAME composer the CLI/MCP surfaces feed from their
// in-memory session, so the live, audit, and durable narrations cannot drift.
// chit_status's top-level `statusLine` summarizes the last round that completed; that
// string is derived from the in-memory session mirror, but every field behind it -- the
// iteration's verdict, its structured checks + verification source, and the stop the
// round produced -- is also written to the loop log, which Studio reads. So Studio can
// show the same line without the MCP server's memory.
//
// What Studio CANNOT show is the in-flight `activity` snapshot (iteration / phase /
// elapsedMs / phaseElapsedMs / lastActivityAgeMs and its nested live statusLine):
// that lives only in ConvergeSession.activity inside the MCP stdio process and is
// never persisted, so it does not flow through the durable log this view reads.
// This line is therefore the LAST COMPLETED round, never a live one.
//
// Studio's only local piece is attributedStop below: mapping a durable stop record to
// the round that caused it. The CLI gets that mapping for free (its session mirror's
// lastStopStatus is set in lockstep with the completing round); Studio must recover it
// from the records, so that logic stays here.

import {
	composeLoopStatusLine,
	type LoopIterationRecord,
	type LoopRecord,
	type LoopStopStatus,
} from "@chit-run/core";

// The stop status the LAST COMPLETED iteration's own verdict gate produced, recovered
// from the durable stop record. The CLI mirrors this as session.lastStopStatus, set in
// lockstep with a completing round and never advanced by a later cancel/failure that
// recorded no iteration -- so the line must only show a stop the last completed round
// actually caused. The durable stop record does not name which round stopped the loop,
// so attribute it the same way the engine's gate does:
//   - cancelled: never a gate outcome (a cancel aborts before a record is appended) ->
//     never attributed.
//   - converged / needs-decision / max-iterations: only a completing iteration's gate
//     (or its budget exhaustion) can produce these -> attributed to the last round.
//   - blocked: either a verdict=block gate (attributed) or an implement failure that
//     recorded no iteration (NOT attributed) -> attribute only when the last completed
//     iteration's own verdict is "block".
function attributedStop(
	last: LoopIterationRecord,
	stop: LoopStopStatus | undefined,
): LoopStopStatus | undefined {
	if (stop === undefined || stop === "cancelled") return undefined;
	if (stop === "blocked") return last.verdict === "block" ? "blocked" : undefined;
	return stop;
}

// "iteration N · <verdict>[ · <checks>][ · <stop>]", recomposed from the loop records.
// Undefined until at least one iteration has completed: an open loop with no completed
// round invents no line, matching the CLI (its statusLine is absent until lastVerdict
// is set). For an in-progress loop with completed rounds it summarizes the last one.
export function loopStatusLine(records: LoopRecord[]): string | undefined {
	const iterations = records.filter((r): r is LoopIterationRecord => r.type === "iteration");
	const last = iterations[iterations.length - 1];
	if (!last) return undefined;
	const stopRec = records.find((r) => r.type === "stop");
	const stop = attributedStop(last, stopRec?.type === "stop" ? stopRec.status : undefined);
	// The shared composer drops the stop word when it would merely restate the outcome
	// (`stop !== outcome`); here outcome is always a verdict and a LoopVerdict and a
	// LoopStopStatus can never share a spelling (the type system proves it), so an
	// attributed stop is always appended.
	return composeLoopStatusLine({
		iteration: last.n,
		outcome: last.verdict,
		checks: last.checks,
		source: last.verificationSource,
		stop,
	});
}
