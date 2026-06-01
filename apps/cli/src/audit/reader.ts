// Shared audit reader: the pure logic for inspecting audited runs, used by both
// the CLI `chit audit list/show` (the human reader) and the MCP audit tools (the
// in-chat reader). Mirrors how converge's single-iteration primitive is shared
// by the CLI and MCP surfaces: one reader, two front-ends.
//
// A run that has no run.completed event is INCOMPLETE, and the reader says WHY
// from the timeline alone (an open adapter call killed mid-flight, a failed step,
// or an abandoned run). It never infers success from the absence of a terminal
// event. Blob bodies are read ONLY through refs that appear in the run's own
// validated events (inputBlob/outputBlob/rawBlob), never from caller-supplied
// paths, so reading bodies can never serve an arbitrary file.

import type { AdapterUsage, AuditEvent } from "@chit-run/core";
import type { AuditStore } from "./store.ts";

// The recorded participant snapshot map, as carried by a run.started event.
// Derived from the event union so reader.ts need not import the snapshot type.
type ParticipantSnapshots = Extract<AuditEvent, { type: "run.started" }>["participants"];

// An adapter call that started but has no matching adapter.call.completed: the
// process was killed or abandoned WHILE the call was in flight. The audit wrapper
// records completed even on error/cancel, so a missing completed means the call
// never returned at all (the wedge/kill case), not a normal failure.
export interface OpenCall {
	stepId: string;
	participantId: string;
	agentId: string;
	since: string;
}

export interface RunSummary {
	runId: string;
	manifestId: string;
	surface: string;
	scope?: string;
	loopId?: string;
	iteration?: number;
	startedAt?: string;
	// The run.completed status, or "incomplete" when there is no terminal event.
	status: string;
	stepCount: number;
	usage?: AdapterUsage;
	// Set only when an adapter call was left open (no completed). Present on
	// incomplete runs killed mid-call; absent on healthy runs.
	openCall?: OpenCall;
}

const USAGE_KEYS: (keyof AdapterUsage)[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
	"estimatedCostUsd",
];

// Sum every adapter.call.completed usage in the run, per field (absent stays
// absent). Cost is the sum of REPORTED costs only, so it is a known-cost floor.
export function sumUsage(events: AuditEvent[]): AdapterUsage | undefined {
	const usage: AdapterUsage = {};
	let any = false;
	for (const e of events) {
		if (e.type !== "adapter.call.completed" || !e.usage) continue;
		for (const k of USAGE_KEYS) {
			const v = e.usage[k];
			if (typeof v === "number") {
				usage[k] = (usage[k] ?? 0) + v;
				any = true;
			}
		}
	}
	return any ? usage : undefined;
}

// Find an adapter call with no matching adapter.call.completed. Keyed by stepId,
// which is safe even when a manifest level runs steps in parallel: step ids are
// unique manifest keys that run once per audit run. Returns the most recent
// still-open call, or undefined when every call settled.
export function findOpenCall(events: AuditEvent[]): OpenCall | undefined {
	const open = new Map<string, OpenCall>();
	for (const e of events) {
		if (e.type === "adapter.call.started") {
			open.set(e.stepId, {
				stepId: e.stepId,
				participantId: e.participantId,
				agentId: e.agentId,
				since: e.ts,
			});
		} else if (e.type === "adapter.call.completed") {
			open.delete(e.stepId);
		}
	}
	let latest: OpenCall | undefined;
	for (const c of open.values()) {
		if (latest === undefined || c.since > latest.since) latest = c;
	}
	return latest;
}

// Explain WHY an incomplete run (no run.completed) ended where it did, from the
// timeline alone. Precedence: a call left open (work killed mid-flight) is the
// most actionable; else a step that failed; else the run was abandoned before any
// terminal marker.
export function describeIncomplete(s: RunSummary, events: AuditEvent[]): string {
	if (s.openCall) {
		const c = s.openCall;
		return `open call: ${c.stepId} ${c.participantId}/${c.agentId} since ${c.since}; no adapter.call.completed`;
	}
	const failed = events.find((e) => e.type === "step.failed");
	if (failed?.type === "step.failed") {
		const err = failed.error.replace(/\s+/g, " ").trim();
		const clipped = err.length > 200 ? `${err.slice(0, 200)}...` : err;
		return `failed step: ${failed.stepId}: ${clipped}`;
	}
	return "abandoned before terminal run.completed";
}

export function summarizeRun(runId: string, events: AuditEvent[]): RunSummary {
	const started = events.find((e) => e.type === "run.started");
	const completed = events.find((e) => e.type === "run.completed");
	const summary: RunSummary = {
		runId,
		manifestId: started?.type === "run.started" ? started.manifestId : "?",
		surface: started?.type === "run.started" ? started.surface : "?",
		status: completed?.type === "run.completed" ? completed.status : "incomplete",
		stepCount: events.filter((e) => e.type === "step.completed").length,
	};
	if (started?.type === "run.started") {
		summary.startedAt = started.ts;
		if (started.scope !== undefined) summary.scope = started.scope;
		if (started.loopId !== undefined) summary.loopId = started.loopId;
		if (started.iteration !== undefined) summary.iteration = started.iteration;
	}
	const usage = sumUsage(events);
	if (usage !== undefined) summary.usage = usage;
	const openCall = findOpenCall(events);
	if (openCall !== undefined) summary.openCall = openCall;
	return summary;
}

// Read a run's events, returning [] on any read error so `list` stays robust
// across a corrupt or mid-write log. `show` reads directly so it can report.
export function safeReadEvents(store: AuditStore, runId: string): AuditEvent[] {
	try {
		return store.readEvents(runId);
	} catch {
		return [];
	}
}

// All audited runs, summarized, newest first; capped to `limit` when given.
export function listAudit(store: AuditStore, limit?: number): RunSummary[] {
	const summaries = store.listRuns().map((id) => summarizeRun(id, safeReadEvents(store, id)));
	summaries.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
	return limit !== undefined ? summaries.slice(0, limit) : summaries;
}

// A timeline entry is the structured audit event, plus the resolved blob bodies
// when (and only when) they were explicitly requested. Bodies come from the
// event's OWN refs, so a timeline can never read a body the run did not record.
export type TimelineEntry = AuditEvent & {
	input?: string;
	output?: string;
	raw?: string;
};

// Two orthogonal knobs control how much a timeline shows. They are separate
// concerns and compose:
//   verbose       - include the raw `adapter.event` rows (the per-call CLI event
//                   stream). Off by default: a run emits dozens of these, and they
//                   would bury the receipt. The run/step/adapter-call lifecycle
//                   always shows.
//   includeBodies - resolve each SHOWN row's own blob refs to their text. Off by
//                   default: bodies are full prompts/outputs and can hold secrets.
// Default is a receipt (no event rows, no bodies). verbose adds the event rows.
// includeBodies adds bodies to whatever rows are shown. verbose + includeBodies is
// the full forensic dump.
export interface TimelineOptions {
	includeBodies: boolean;
	verbose: boolean;
}

function readBody(store: AuditStore, runId: string, ref: string): string {
	try {
		return store.readBlob(runId, ref);
	} catch (err) {
		return `<blob unavailable: ${(err as Error).message}>`;
	}
}

// The raw CLI event stream (Codex JSONL / Claude stream-json) arrives as
// `adapter.event` rows. They are the bulk of a run's events and the least legible
// line by line, so they are the rows `verbose` gates. Everything else is the
// receipt: run/step lifecycle and adapter-call started/completed.
export function isReceiptEvent(e: AuditEvent): boolean {
	return e.type !== "adapter.event";
}

export function hiddenAdapterEventCount(events: AuditEvent[]): number {
	return events.reduce((n, e) => (e.type === "adapter.event" ? n + 1 : n), 0);
}

// The run's events as a structured timeline. Without verbose, the raw
// `adapter.event` rows are dropped (a receipt, not an event log). With
// includeBodies, each SHOWN row's own blob refs are resolved to text. Never reads
// a ref not present on the event itself.
export function auditTimeline(
	store: AuditStore,
	runId: string,
	events: AuditEvent[],
	opts: TimelineOptions,
): TimelineEntry[] {
	const rows = opts.verbose ? events : events.filter(isReceiptEvent);
	return rows.map((e): TimelineEntry => {
		if (!opts.includeBodies) return e;
		if (e.type === "adapter.call.started") {
			return { ...e, input: readBody(store, runId, e.inputBlob) };
		}
		if (e.type === "adapter.event" && e.rawBlob !== undefined) {
			return { ...e, raw: readBody(store, runId, e.rawBlob) };
		}
		if (e.type === "adapter.call.completed") {
			return { ...e, output: readBody(store, runId, e.outputBlob) };
		}
		if (e.type === "step.completed" && e.outputBlob !== undefined) {
			return { ...e, output: readBody(store, runId, e.outputBlob) };
		}
		return e;
	});
}

export interface AuditShow {
	summary: RunSummary;
	// Present only when the run is incomplete: why it ended where it did.
	incompleteReason?: string;
	// The participant config recorded at run.started (an older run may lack it).
	participants?: ParticipantSnapshots;
	timeline: TimelineEntry[];
	// Set when the default receipt view hid raw adapter.event rows: how many, and
	// how to see them. Absent under verbose, or when the run had no such rows.
	note?: string;
}

// One run's full inspection: the summary header, the incomplete reason when
// applicable, the recorded participant snapshot, and the timeline. By default the
// timeline is a receipt (no raw adapter.event rows, no bodies); `verbose` adds the
// event rows and `includeBodies` adds blob bodies, independently. store.readEvents
// throws on an invalid or missing run id; the caller maps that to its surface.
export function showAudit(store: AuditStore, runId: string, opts: TimelineOptions): AuditShow {
	const events = store.readEvents(runId);
	const summary = summarizeRun(runId, events);
	const out: AuditShow = {
		summary,
		timeline: auditTimeline(store, runId, events, opts),
	};
	if (summary.status === "incomplete") out.incompleteReason = describeIncomplete(summary, events);
	const started = events.find((e) => e.type === "run.started");
	if (started?.type === "run.started" && started.participants !== undefined) {
		out.participants = started.participants;
	}
	if (!opts.verbose) {
		const hidden = hiddenAdapterEventCount(events);
		if (hidden > 0) {
			out.note = `${hidden} raw adapter events hidden; pass verbose to include them, include_bodies to show blob bodies.`;
		}
	}
	return out;
}
