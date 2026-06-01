// `chit audit` - read the audit transcripts that audited runs write (chit
// converge by default, chit run --audit, MCP chit_run_start audit:true). Read-only
// inspection: `list` the runs, or `show <runId>` one run's event timeline, with
// optional blob bodies (prompts/outputs) and a usage/cost summary. The store +
// event schema live in audit/store.ts and @chit-run/core; this is the human reader.
//
// A run that has no run.completed event is reported INCOMPLETE, and the reader
// says WHY from the timeline alone: an open adapter call (started, never
// completed: the killed-mid-call / wedge case), a failed step, or an abandoned
// run with no terminal marker. The reader never infers success from the absence
// of a terminal event.

import {
	type AuditEvent,
	configPairs,
	formatAdapterUsage,
	participantPermissionText,
} from "@chit-run/core";
import {
	describeIncomplete,
	hiddenAdapterEventCount,
	isReceiptEvent,
	type RunSummary,
	safeReadEvents,
	summarizeRun,
} from "../audit/reader.ts";
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
  show <runId>             Show one run as a receipt (summary, participants, timeline).

list options:
  --json                   Emit the run summaries as JSON.

show options:
  --json                   Emit the raw events as JSON.
  --verbose                Include the raw adapter.event rows (the CLI event stream).
  --blobs, --include-bodies  Print blob bodies (rendered prompts, outputs).

Audited runs live under the local state dir (XDG_STATE_HOME or ~/.local/state,
then chit/audit). A run with no run.completed event is shown as INCOMPLETE.
`;

class UsageError extends Error {}

function runList(store: AuditStore, io: AuditIO, json: boolean): number {
	const summaries: RunSummary[] = [];
	for (const runId of store.listRuns()) {
		summaries.push(summarizeRun(runId, safeReadEvents(store, runId)));
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
	opts: { json: boolean; blobs: boolean; verbose: boolean },
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

	const s = summarizeRun(runId, events);
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
			io.out(
				`  ${pid}  agent=${p.agentId}  session=${p.session}  ${participantPermissionText(p)}  adapter=${p.adapter}\n`,
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
	// Receipt by default: drop the raw adapter.event stream rows unless --verbose.
	// --blobs (bodies) is independent of --verbose (which rows to show).
	const rows = opts.verbose ? events : events.filter(isReceiptEvent);
	for (const e of rows) {
		for (const line of renderEvent(store, runId, e, opts.blobs)) io.out(`  ${line}\n`);
	}
	if (!opts.verbose) {
		const hidden = hiddenAdapterEventCount(events);
		if (hidden > 0) {
			io.out(`\n  (${hidden} raw adapter events hidden; pass --verbose to include them.)\n`);
		}
	}
	return 0;
}

interface ParsedAudit {
	command: "list" | "show";
	runId?: string;
	json: boolean;
	blobs: boolean;
	verbose: boolean;
}

function parseAuditArgs(argv: string[]): ParsedAudit {
	const sub = argv[0];
	if (sub !== "list" && sub !== "show") {
		throw new UsageError(`unknown audit command ${JSON.stringify(sub ?? "")}`);
	}
	const out: ParsedAudit = { command: sub, json: false, blobs: false, verbose: false };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") out.json = true;
		else if (a === "--blobs" || a === "--include-bodies") out.blobs = true;
		else if (a === "--verbose") out.verbose = true;
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
		verbose: parsed.verbose,
	});
}
