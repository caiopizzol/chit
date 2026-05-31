// `chit audit` — read the audit transcripts that audited runs write (chit
// converge by default, chit run --audit, MCP chit_start audit:true). Read-only
// inspection: `list` the runs, or `show <runId>` one run's event timeline, with
// optional blob bodies (prompts/outputs) and a usage/cost summary. The store +
// event schema live in audit/store.ts and @chit/core; this is the human reader.
//
// A run that has no run.completed event is reported INCOMPLETE: a failed or
// cancelled MCP step records step.failed but no terminal run event, and a run
// can be abandoned. The reader never infers success from the absence of a
// terminal event.

import type { AdapterUsage, AuditEvent } from "@chit/core";
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
then handoff/audit). A run with no run.completed event is shown as INCOMPLETE.
`;

class UsageError extends Error {}

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
	return summary;
}

// Render a usage block as a compact one-liner. Cost is labelled "reported cost"
// because not every provider reports one (Codex does not), so it is a floor.
function renderUsage(usage: AdapterUsage | undefined): string {
	if (!usage) return "usage: none reported";
	const parts: string[] = [];
	if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
	if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
	if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens}`);
	if (usage.reasoningTokens !== undefined) parts.push(`reasoning ${usage.reasoningTokens}`);
	if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
	const tokens = parts.length > 0 ? `tokens: ${parts.join(", ")}` : "tokens: none";
	const cost =
		usage.estimatedCostUsd !== undefined
			? `; reported cost: $${usage.estimatedCostUsd.toFixed(4)}`
			: "";
	return `${tokens}${cost}`;
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
	const summaries = store
		.listRuns()
		.map((runId) => summarize(runId, safeRead(store, runId)))
		.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

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
		io.out(
			`${s.runId}  [${s.surface}] ${s.manifestId}  ${s.status}  steps=${s.stepCount}${loop}\n`,
		);
		io.out(`    started ${s.startedAt ?? "?"}  ${renderUsage(s.usage)}\n`);
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
				`adapter.call.completed  ${e.stepId} ${e.status} ${e.durationMs}ms  ${renderUsage(e.usage)}`,
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
	io.out(
		`  status: ${s.status}${s.status === "incomplete" ? " (no run.completed: failed, cancelled, or abandoned)" : ""}\n`,
	);
	io.out(`  ${renderUsage(s.usage)}\n`);
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
	return runShow(store, parsed.runId as string, io, { json: parsed.json, blobs: parsed.blobs });
}
