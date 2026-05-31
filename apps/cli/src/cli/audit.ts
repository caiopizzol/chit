// `chit audit` - read the audit transcripts that audited runs write (chit
// converge by default, chit run --audit, MCP chit_start audit:true). Read-only
// inspection: `list` the runs, or `show <runId>` one run's event timeline, with
// optional blob bodies (prompts/outputs) and a usage/cost summary. The store +
// event schema live in audit/store.ts and @chit/core; this is the human reader.
//
// A run that has no run.completed event is reported INCOMPLETE, and the reader
// says WHY from the timeline alone: an open adapter call (started, never
// completed: the killed-mid-call / wedge case), a failed step, or an abandoned
// run with no terminal marker. The reader never infers success from the absence
// of a terminal event.

import { type AdapterUsage, type AuditEvent, configPairs, formatAdapterUsage } from "@chit/core";
import { AuditStore } from "../audit/store.ts";

export interface AuditIO {
	out: (s: string) => void;
	err: (s: string) => void;
}

const defaultIO: AuditIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

const AUDIT_HELP = `chit audit <command> [options]

  list                     List audited runs, newest first.
  show <runId>             Show one run's event timeline.

list options:
  --json                   Emit the run summaries as JSON.

show options:
  --json                   Emit the raw events as JSON.
  --blobs, --include-bodies  Print blob bodies (rendered prompts, outputs).

Audited runs live under the local state dir (XDG_STATE_HOME or ~/.local/state,
then chit/audit). A run with no run.completed event is shown as INCOMPLETE.
`;

class UsageError extends Error {}

// An adapter call that started but has no matching adapter.call.completed: the
// process was killed or abandoned WHILE the call was in flight. The audit
// wrapper records completed even on error/cancel, so a missing completed means
// the call never returned at all (the wedge/kill case), not a normal failure.
interface OpenCall {
	stepId: string;
	participantId: string;
	agentId: string;
	since: string;
}

interface RunSummary {
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
	// incomplete runs that were killed mid-call; absent on healthy runs.
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
function sumUsage(events: AuditEvent[]): AdapterUsage | undefined {
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
// which is safe even when a manifest level runs its steps in parallel: step ids
// are unique manifest keys that run once per audit run, so concurrent calls
// occupy distinct keys and never collide. Returns the most recent still-open
// call, or undefined when every call settled. This is the "killed mid-call"
// signal: a normal error/cancel still records a completed event.
function findOpenCall(events: AuditEvent[]): OpenCall | undefined {
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
// most actionable; else a step that failed; else the run was abandoned before
// any terminal marker. The reason follows the "incomplete" label in `show`.
function describeIncomplete(s: RunSummary, events: AuditEvent[]): string {
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

function summarize(runId: string, events: AuditEvent[]): RunSummary {
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
// across a corrupt or mid-write log (show() reads directly so it can report).
function safeRead(store: AuditStore, runId: string): AuditEvent[] {
	try {
		return store.readEvents(runId);
	} catch {
		return [];
	}
}

function runList(store: AuditStore, io: AuditIO, json: boolean): number {
	const summaries: RunSummary[] = [];
	for (const runId of store.listRuns()) {
		summaries.push(summarize(runId, safeRead(store, runId)));
	}
	summaries.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

	if (json) {
		io.out(`${JSON.stringify(summaries, null, 2)}\n`);
		return 0;
	}
	if (summaries.length === 0) {
		io.out("no audit runs.\n");
		return 0;
	}
	for (const s of summaries) {
		const loop = s.loopId ? ` loop=${s.loopId}#${s.iteration ?? "?"}` : "";
		// Name the open call inline so a killed-mid-call run is diagnosable from the
		// list alone, not only after a `show`.
		const open = s.openCall ? ` open=${s.openCall.stepId}/${s.openCall.agentId}` : "";
		io.out(
			`${s.runId}  [${s.surface}] ${s.manifestId}  ${s.status}${open}  steps=${s.stepCount}${loop}\n`,
		);
		io.out(`    started ${s.startedAt ?? "?"}  ${formatAdapterUsage(s.usage)}\n`);
	}
	io.out('\n("incomplete" = no run.completed event: failed, cancelled, or abandoned.)\n');
	return 0;
}

// One timeline line per event. Blob bodies are printed (indented) only with
// --blobs, since they hold full prompts/outputs that can be large or sensitive.
function renderEvent(store: AuditStore, runId: string, e: AuditEvent, blobs: boolean): string[] {
	const lines: string[] = [];
	const body = (ref: string | undefined, label: string) => {
		if (!blobs || ref === undefined) return;
		let text: string;
		try {
			text = store.readBlob(runId, ref);
		} catch (err) {
			text = `<blob unavailable: ${(err as Error).message}>`;
		}
		lines.push(`      ${label}:`);
		for (const line of text.split("\n")) lines.push(`      | ${line}`);
	};

	switch (e.type) {
		case "run.started":
			lines.push(
				`run.started   manifest=${e.manifestId} surface=${e.surface}${e.scope ? ` scope=${e.scope}` : ""}`,
			);
			break;
		case "step.started":
			lines.push(
				`step.started  ${e.stepId} (${e.kind})${e.agentId ? ` ${e.participantId}/${e.agentId}` : ""}`,
			);
			break;
		case "adapter.call.started":
			lines.push(`adapter.call.started  ${e.stepId} ${e.participantId}/${e.agentId}`);
			body(e.inputBlob, "input");
			break;
		case "adapter.event":
			lines.push(`adapter.event  ${e.stepId} ${e.eventType}${e.note ? ` ${e.note}` : ""}`);
			body(e.rawBlob, "raw");
			break;
		case "adapter.call.completed":
			lines.push(
				`adapter.call.completed  ${e.stepId} ${e.status} ${e.durationMs}ms  ${formatAdapterUsage(e.usage)}`,
			);
			body(e.outputBlob, "output");
			break;
		case "step.completed":
			lines.push(`step.completed  ${e.stepId} ${e.durationMs}ms`);
			body(e.outputBlob, "output");
			break;
		case "step.failed":
			lines.push(`step.failed  ${e.stepId} ${e.durationMs}ms  ${e.error}`);
			break;
		case "loop.iteration.recorded":
			lines.push(
				`loop.iteration.recorded  n=${e.n} verdict=${e.verdict} decision=${e.decision} findings=${e.findingCount}`,
			);
			break;
		case "run.completed":
			lines.push(`run.completed  ${e.status} ${e.durationMs}ms`);
			break;
	}
	return lines;
}

function runShow(
	store: AuditStore,
	runId: string,
	io: AuditIO,
	opts: { json: boolean; blobs: boolean },
): number {
	let events: AuditEvent[];
	try {
		events = store.readEvents(runId);
	} catch (e) {
		io.err(`chit audit: ${(e as Error).message}\n`);
		return 1;
	}

	if (opts.json) {
		io.out(`${JSON.stringify(events, null, 2)}\n`);
		return 0;
	}

	const s = summarize(runId, events);
	io.out(`run ${runId}\n`);
	io.out(
		`  manifest: ${s.manifestId}   surface: ${s.surface}${s.scope ? `   scope: ${s.scope}` : ""}\n`,
	);
	if (s.loopId) io.out(`  loop: ${s.loopId} iteration ${s.iteration ?? "?"}\n`);
	io.out(`  started: ${s.startedAt ?? "?"}\n`);
	const reason = s.status === "incomplete" ? ` (${describeIncomplete(s, events)})` : "";
	io.out(`  status: ${s.status}${reason}\n`);
	io.out(`  ${formatAdapterUsage(s.usage)}\n`);

	// Recorded participant config: what this run actually used at start. Render the
	// SNAPSHOT, never today's registry (which can have changed since the run). An
	// older run that predates the snapshot says so rather than guessing.
	const startedEvent = events.find((e) => e.type === "run.started");
	const snapshots = startedEvent?.type === "run.started" ? startedEvent.participants : undefined;
	io.out("\nparticipants (recorded config):\n");
	if (!snapshots || Object.keys(snapshots).length === 0) {
		io.out("  recorded config unavailable (older audit run)\n");
	} else {
		for (const [pid, p] of Object.entries(snapshots)) {
			const enforces = p.enforcesReadOnly ? "enforces=yes" : "enforces=NO";
			io.out(
				`  ${pid}  agent=${p.agentId}  session=${p.session}  permissions=${p.permissions.filesystem}  adapter=${p.adapter}  ${enforces}\n`,
			);
			const pairs =
				p.adapter === "unknown"
					? "unresolved (unknown agent)"
					: configPairs(p.config)
							.map(([k, v]) => `${k}=${v}`)
							.join("  ");
			io.out(`    config  ${pairs}\n`);
		}
	}

	io.out("\ntimeline:\n");
	for (const e of events) {
		for (const line of renderEvent(store, runId, e, opts.blobs)) io.out(`  ${line}\n`);
	}
	return 0;
}

interface ParsedAudit {
	command: "list" | "show";
	runId?: string;
	json: boolean;
	blobs: boolean;
}

function parseAuditArgs(argv: string[]): ParsedAudit {
	const sub = argv[0];
	if (sub !== "list" && sub !== "show") {
		throw new UsageError(`unknown audit command ${JSON.stringify(sub ?? "")}`);
	}
	const out: ParsedAudit = { command: sub, json: false, blobs: false };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") out.json = true;
		else if (a === "--blobs" || a === "--include-bodies") out.blobs = true;
		else if (
			a !== undefined &&
			!a.startsWith("--") &&
			out.command === "show" &&
			out.runId === undefined
		) {
			out.runId = a;
		} else {
			throw new UsageError(`unexpected argument ${JSON.stringify(a)}`);
		}
	}
	if (out.command === "show" && out.runId === undefined) {
		throw new UsageError("audit show requires a <runId>");
	}
	return out;
}

export function runAudit(
	argv: string[],
	io: AuditIO = defaultIO,
	store: AuditStore = new AuditStore(),
): number {
	if (argv[0] === "-h" || argv[0] === "--help" || argv.length === 0) {
		io.out(AUDIT_HELP);
		return argv.length === 0 ? 2 : 0;
	}
	let parsed: ParsedAudit;
	try {
		parsed = parseAuditArgs(argv);
	} catch (e) {
		if (e instanceof UsageError) {
			io.err(`chit audit: ${e.message}\n\n${AUDIT_HELP}`);
			return 2;
		}
		throw e;
	}
	if (parsed.command === "list") return runList(store, io, parsed.json);
	return runShow(store, parsed.runId as string, io, {
		json: parsed.json,
		blobs: parsed.blobs,
	});
}
