// wrapAdaptersWithAudit: decorate an AdapterMap so each adapter call records an
// adapter.call.started (input blob) before and an adapter.call.completed (output
// blob + usage + duration + status) after, via the run's AuditRecorder. Mirrors
// wrapAdaptersWithSessions, so both surfaces that build adapters can opt in with
// one wrap call.
//
// Apply this BENEATH the session wrapper (sessions(audit(base))) so the recorder
// sees the prior session the session layer injected and the new session the
// adapter returns. The wrapper is transparent: it returns the inner result
// unchanged and rethrows the inner error, so execution is identical with or
// without audit.

import type { AdapterCallRequest, AdapterEvent, AdapterMap } from "../runtime/types.ts";
import type { AuditRecorder } from "./recorder.ts";

export function wrapAdaptersWithAudit(adapters: AdapterMap, recorder: AuditRecorder): AdapterMap {
	const out: AdapterMap = {};
	for (const [agentId, adapter] of Object.entries(adapters)) {
		out[agentId] = {
			async call(req: AdapterCallRequest) {
				recorder.adapterCallStarted(req);
				const startedAt = Date.now();
				// Record each intra-call adapter event (e.g. Codex JSONL lines) as an
				// adapter.event, forwarding any onEvent the caller already set. An
				// adapter that surfaces no events (claude --print) simply never calls it.
				const existing = req.onEvent;
				const onEvent = (event: AdapterEvent) => {
					recorder.adapterEvent(req.stepId, event);
					existing?.(event);
				};
				try {
					const result = await adapter.call({ ...req, onEvent });
					// A call that RETURNS after its signal was aborted was still
					// cancelled (the caller discards the output), so record it cancelled
					// to match how the run treats it. Surfaces that pass no signal
					// (converge, chit run) always see "ok" here.
					const status = req.signal?.aborted ? "cancelled" : "ok";
					recorder.adapterCallCompleted(req, result, Date.now() - startedAt, status, result.output);
					return result;
				} catch (e) {
					// A client-aborted call is a cancellation, not a failure; otherwise
					// it is an error (a timeout surfaces as an error whose message says so
					// — distinguishing timeout as its own status is a later refinement).
					const status = req.signal?.aborted ? "cancelled" : "error";
					const message = e instanceof Error ? e.message : String(e);
					recorder.adapterCallCompleted(req, undefined, Date.now() - startedAt, status, message);
					throw e;
				}
			},
		};
	}
	return out;
}
