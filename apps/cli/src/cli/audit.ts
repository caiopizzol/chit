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
	type AuditSurface,
	configPairs,
	formatAdapterUsage,
	participantPermissionText,
} from "@chit-run/core";
import {
	type AggregateOptions,
	aggregateReceipts,
	type ReceiptAggregate,
} from "../audit/aggregate.ts";
import {
	describeIncomplete,
	hiddenAdapterEventCount,
	isReceiptEvent,
	type RunSummary,
	safeReadEvents,
	summarizeRun,
} from "../audit/reader.ts";
import { AuditStore } from "../audit/store.ts";
import { repoRoot } from "../loops/location.ts";

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
  stats                    Roll up metrics for this repo's runs (no bodies, no paths).

list options:
  --json                   Emit the run summaries as JSON.

show options:
  --json                   Emit the raw events as JSON.
  --verbose                Include the raw adapter.event rows (the CLI event stream).
  --blobs, --include-bodies  Print blob bodies (rendered prompts, outputs).

stats options (defaults to runs from the current repo):
  --json                   Emit the aggregate as JSON.
  --all-repos              Fold runs from every repo in the state dir, not just this one.
  --since <iso>            Only runs whose startedAt is >= this ISO timestamp.
  --until <iso>            Only runs whose startedAt is <= this ISO timestamp.
  --surface <cli|mcp|converge>  Restrict to one audit surface.
  --scope <label>          Restrict to one scope (filter only; never printed).
  --limit <n>              Cap runs folded, newest first.

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

// Render a Record<string, number> as "key=count" pairs, sorted by count
// descending then key, so the table is stable and the busiest dimension leads.
function countLine(counts: Record<string, number>): string {
	const entries = Object.entries(counts);
	if (entries.length === 0) return "none";
	return entries
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k, n]) => `${k}=${n}`)
		.join("  ");
}

function runStats(
	store: AuditStore,
	io: AuditIO,
	opts: AggregateOptions,
	json: boolean,
	scope: { allRepos: boolean; cwd: string },
): number {
	// Default to this repo: the audit store is one per-user state dir shared across
	// every repo, so an unscoped roll-up would mix unrelated repos. repoRoot maps a
	// run's recorded cwd (any subdir) to its git top-level for the comparison; the
	// path itself is never emitted. --all-repos opts out for a cross-repo view.
	const effective: AggregateOptions = scope.allRepos
		? opts
		: { ...opts, repoRoot: repoRoot(scope.cwd), resolveRepoRoot: repoRoot };
	const agg: ReceiptAggregate = aggregateReceipts(store, effective);
	if (json) {
		io.out(`${JSON.stringify(agg, null, 2)}\n`);
		return 0;
	}
	const where = scope.allRepos ? "all repos" : "this repo";
	if (agg.runs === 0) {
		io.out(`no runs matched in ${where} (skipped ${agg.skipped} unreadable/empty).\n`);
		return 0;
	}
	io.out(`runs: ${agg.runs} in ${where}  (skipped ${agg.skipped} unreadable/empty)\n`);
	if (agg.timeRange) io.out(`range: ${agg.timeRange.earliest} .. ${agg.timeRange.latest}\n`);
	io.out(`surface:  ${countLine(agg.bySurface)}\n`);
	io.out(`status:   ${countLine(agg.byStatus)}\n`);
	io.out(`recipe:   ${countLine(agg.byRecipe)}\n`);
	io.out(`steps: ${agg.steps}  failed steps: ${agg.failedSteps}\n`);
	const c = agg.convergence;
	io.out(
		`convergence: ${c.iterations} iterations  verdict[${countLine(c.verdicts)}]  decision[${countLine(c.decisions)}]\n`,
	);
	io.out(
		`             findings=${c.findingCount}  with verification source=${c.withVerificationSource}/${c.iterations}\n`,
	);
	io.out(`usage: ${formatAdapterUsage(agg.usage)}\n`);
	io.out('\n("ok" = converged/completed; "incomplete" = no run.completed.)\n');
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
	command: "list" | "show" | "stats";
	runId?: string;
	json: boolean;
	blobs: boolean;
	verbose: boolean;
	stats: AggregateOptions;
	// stats only: fold runs from every repo in the shared state dir instead of
	// scoping to the current repo (the default).
	allRepos: boolean;
}

const AUDIT_SURFACES: ReadonlySet<string> = new Set(["cli", "mcp", "converge"]);

// Read the value following a `--flag`, advancing the index. Throws when the flag
// is the last token (no value), so a typo never silently swallows the next flag.
function takeValue(argv: string[], i: number, flag: string): string {
	const v = argv[i + 1];
	if (v === undefined || v.startsWith("--")) {
		throw new UsageError(`${flag} requires a value`);
	}
	return v;
}

function parseAuditArgs(argv: string[]): ParsedAudit {
	const sub = argv[0];
	if (sub !== "list" && sub !== "show" && sub !== "stats") {
		throw new UsageError(`unknown audit command ${JSON.stringify(sub ?? "")}`);
	}
	const out: ParsedAudit = {
		command: sub,
		json: false,
		blobs: false,
		verbose: false,
		stats: {},
		allRepos: false,
	};
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") out.json = true;
		else if (a === "--blobs" || a === "--include-bodies") out.blobs = true;
		else if (a === "--verbose") out.verbose = true;
		else if (out.command === "stats" && a === "--all-repos") out.allRepos = true;
		else if (out.command === "stats" && a === "--since") out.stats.since = takeValue(argv, i++, a);
		else if (out.command === "stats" && a === "--until") out.stats.until = takeValue(argv, i++, a);
		else if (out.command === "stats" && a === "--scope") out.stats.scope = takeValue(argv, i++, a);
		else if (out.command === "stats" && a === "--surface") {
			const s = takeValue(argv, i++, a);
			if (!AUDIT_SURFACES.has(s))
				throw new UsageError(`--surface must be one of cli, mcp, converge`);
			out.stats.surface = s as AuditSurface;
		} else if (out.command === "stats" && a === "--limit") {
			const raw = takeValue(argv, i++, a);
			const n = Number(raw);
			if (!Number.isInteger(n) || n < 0) {
				throw new UsageError("--limit must be a non-negative integer");
			}
			out.stats.limit = n;
		} else if (
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
	cwd: string = process.cwd(),
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
	if (parsed.command === "stats") {
		return runStats(store, io, parsed.stats, parsed.json, { allRepos: parsed.allRepos, cwd });
	}
	return runShow(store, parsed.runId as string, io, {
		json: parsed.json,
		blobs: parsed.blobs,
		verbose: parsed.verbose,
	});
}
