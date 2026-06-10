import type { TraceEvent } from "./types.ts";

// A privacy-safe digest of one runtime event, fit to cross trust boundaries
// (persisted state files, studio polling responses). It deliberately carries
// no payloads: no prompt, no output, no error text, no raw adapter line. The
// label is built here from structural facts only, so a summary can be shown
// anywhere without re-sanitizing.
export interface LiveEventSummary {
	// Wall-clock arrival time (epoch ms).
	ts: number;
	kind: LiveEventKind;
	// Human-readable one-liner built from ids/types only, never from payloads.
	label: string;
	stepId?: string;
	participantId?: string;
	agentId?: string;
}

export type LiveEventKind = "step.started" | "step.completed" | "step.failed" | "adapter.event";

const LIVE_EVENT_KINDS: ReadonlySet<string> = new Set([
	"step.started",
	"step.completed",
	"step.failed",
	"adapter.event",
]);

// Keep the tail small: it exists to answer "what is the run doing right now",
// not to be a second audit log (the audit recorder keeps the full history).
export const MAX_LIVE_EVENTS = 50;

// Append keeping only the newest MAX_LIVE_EVENTS. Mutates in place so callers
// can hold one array across a run.
export function appendLiveEvent(events: LiveEventSummary[], event: LiveEventSummary): void {
	events.push(event);
	if (events.length > MAX_LIVE_EVENTS) {
		events.splice(0, events.length - MAX_LIVE_EVENTS);
	}
}

// Summarize a trace event. step.started carries a prompt and step.completed an
// output in the trace; neither is read here. step.failed's label states the
// fact of failure only - error text stays in the trace/audit trail.
export function summarizeTraceEvent(event: TraceEvent, ts: number): LiveEventSummary {
	switch (event.type) {
		case "step.started":
			return {
				ts,
				kind: "step.started",
				label: `step ${event.stepId} started`,
				stepId: event.stepId,
				...(event.participantId !== undefined && { participantId: event.participantId }),
				...(event.agentId !== undefined && { agentId: event.agentId }),
			};
		case "step.completed":
			return {
				ts,
				kind: "step.completed",
				label: `step ${event.stepId} completed (${event.durationMs}ms)`,
				stepId: event.stepId,
			};
		case "step.failed":
			return {
				ts,
				kind: "step.failed",
				label: `step ${event.stepId} failed (${event.durationMs}ms)`,
				stepId: event.stepId,
			};
	}
}

// Summarize an intra-call adapter event. Takes the event type string only -
// not the AdapterEvent - so the raw payload can never reach a summary, by
// construction rather than by discipline at each call site.
export function summarizeAdapterEvent(
	type: string,
	ctx: { stepId: string; participantId?: string; agentId?: string },
	ts: number,
): LiveEventSummary {
	return {
		ts,
		kind: "adapter.event",
		label: type,
		stepId: ctx.stepId,
		...(ctx.participantId !== undefined && { participantId: ctx.participantId }),
		...(ctx.agentId !== undefined && { agentId: ctx.agentId }),
	};
}

// Trust-boundary reconstructor for summaries read back from outside this
// process (a state file another process wrote, a payload from a tool caller).
// Each entry is rebuilt field-by-field onto a fresh object, so anything not in
// LiveEventSummary - raw, body, prompt, output, error, session, whatever -
// is dropped rather than carried along. Malformed entries are dropped
// silently; a corrupt tail is not worth failing a status read over. Keeps the
// newest MAX_LIVE_EVENTS valid entries.
//
// When a reader clock is supplied, entries dated in the future of that clock
// are dropped as invalid BEFORE the cap: they have no derivable age for this
// reader, and counting them against the cap would let a skewed or hostile
// tail crowd out the datable entries a reader could actually show. Read-only
// consumers (status views, the Studio live tower) pass their clock;
// read-modify-write sanitization passes none, because a future timestamp from
// a merely skewed writer is not the reader's to destroy on disk.
export function sanitizeLiveEvents(value: unknown, nowMs?: number): LiveEventSummary[] {
	if (!Array.isArray(value)) return [];
	const valid: LiveEventSummary[] = [];
	for (const entry of value) {
		const summary = sanitizeLiveEvent(entry);
		if (!summary) continue;
		if (nowMs !== undefined && summary.ts > nowMs) continue;
		valid.push(summary);
	}
	return valid.slice(-MAX_LIVE_EVENTS);
}

function sanitizeLiveEvent(entry: unknown): LiveEventSummary | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const e = entry as Record<string, unknown>;
	if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return undefined;
	if (typeof e.kind !== "string" || !LIVE_EVENT_KINDS.has(e.kind)) return undefined;
	if (typeof e.label !== "string") return undefined;
	const summary: LiveEventSummary = {
		ts: e.ts,
		kind: e.kind as LiveEventKind,
		label: e.label,
	};
	if (typeof e.stepId === "string") summary.stepId = e.stepId;
	if (typeof e.participantId === "string") summary.participantId = e.participantId;
	if (typeof e.agentId === "string") summary.agentId = e.agentId;
	return summary;
}
