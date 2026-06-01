// `chit loop-log <start|append|stop|show>` — the thin CLI over the convergence
// log store. It only parses flags, resolves --cwd, and calls the store. It
// never accepts store-owned derived fields (the iteration number, the stop
// iteration count): each verb has an allow-list of flags, and an unknown flag
// like --n or --iterations is rejected, not ignored. Lives in its own module
// and is delegated to from runMain so the main CLI's flat-command parser stays
// simple.

import { resolve } from "node:path";
import {
	LoopLogError,
	type LoopRecord,
	type LoopStopStatus,
	type LoopVerdict,
} from "@chit-run/core";
import {
	appendIteration,
	LoopStoreError,
	readLoop,
	startLoop,
	stopLoop,
} from "../loops/log-store.ts";

export interface LoopLogIO {
	out: (s: string) => void;
	err: (s: string) => void;
}

const defaultIO: LoopLogIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

// Per-verb allow-lists. Derived fields (n, iterations, totalElapsedMs) are
// deliberately absent: the store computes them, the CLI cannot supply them.
const ALLOWED: Record<string, { flags: readonly string[]; bools: readonly string[] }> = {
	start: { flags: ["cwd", "scope", "task", "max-iterations", "loop-id"], bools: ["force"] },
	append: {
		flags: [
			"cwd",
			"loop-id",
			"summary",
			"changed-files",
			"checks-run",
			"verdict",
			"finding-count",
			"decision",
			"duration-ms",
			"details-ref",
		],
		bools: [],
	},
	stop: { flags: ["cwd", "loop-id", "status", "reason"], bools: [] },
	show: { flags: ["cwd", "loop-id"], bools: ["json"] },
};

const LOOP_LOG_HELP = `chit loop-log <start|append|stop|show> [flags]

  start   --scope <s> --task <t> --max-iterations <n> [--cwd <dir>] [--loop-id <id>] [--force]
  append  --loop-id <id> --summary <t> --changed-files <json> --checks-run <t>
          --verdict <proceed|revise|block> --finding-count <n>
          --decision <proceed|revise|block> --duration-ms <n> [--details-ref <r>] [--cwd <dir>]
  stop    --loop-id <id> --status <converged|blocked|max-iterations|needs-decision> --reason <t> [--cwd <dir>]
  show    --loop-id <id> [--json] [--cwd <dir>]

The store owns the iteration number and the stop totals; you cannot pass them.
`;

class UsageError extends Error {}

interface Parsed {
	flags: Record<string, string>;
	bools: Set<string>;
}

function parseFlags(verb: string, argv: string[]): Parsed {
	const allowed = ALLOWED[verb];
	if (!allowed) {
		throw new UsageError(`unknown subcommand "${verb}" (use start|append|stop|show)`);
	}
	const allowedFlags = new Set(allowed.flags);
	const allowedBools = new Set(allowed.bools);
	const flags: Record<string, string> = {};
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a?.startsWith("--")) throw new UsageError(`unexpected argument "${a}"`);
		const key = a.slice(2);
		if (allowedBools.has(key)) {
			bools.add(key);
			continue;
		}
		if (!allowedFlags.has(key)) throw new UsageError(`unknown flag --${key} for loop-log ${verb}`);
		const v = argv[++i];
		if (v === undefined) throw new UsageError(`--${key} requires a value`);
		flags[key] = v;
	}
	return { flags, bools };
}

function req(p: Parsed, key: string, verb: string): string {
	const v = p.flags[key];
	if (v === undefined) throw new UsageError(`loop-log ${verb} requires --${key}`);
	return v;
}

function intFlag(p: Parsed, key: string, verb: string): number {
	const raw = req(p, key, verb);
	const n = Number(raw);
	if (!Number.isInteger(n)) {
		throw new UsageError(`--${key} must be an integer (got ${JSON.stringify(raw)})`);
	}
	return n;
}

function parseChangedFiles(raw: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new UsageError("--changed-files must be a JSON array of strings");
	}
	if (!Array.isArray(parsed) || parsed.some((e) => typeof e !== "string")) {
		throw new UsageError("--changed-files must be a JSON array of strings");
	}
	return parsed as string[];
}

function renderLoop(records: LoopRecord[]): string {
	const lines: string[] = [];
	const header = records.find((r) => r.type === "loop");
	const stop = records.find((r) => r.type === "stop");
	if (header?.type === "loop") {
		const status = stop?.type === "stop" ? stop.status : "in progress";
		lines.push(`Loop  ${header.scope}  [ ${status} ]`);
		lines.push(header.task);
	}
	for (const r of records) {
		if (r.type === "iteration") {
			lines.push("");
			lines.push(`  ${r.n}. ${r.implementSummary}`);
			lines.push(
				`     ${r.changedFiles.length} files · check ${r.verdict.toUpperCase()} · ` +
					`${Math.round(r.checkDurationMs / 1000)}s · ${r.findingCount} findings`,
			);
			lines.push(`     decide ${r.decision}`);
		} else if (r.type === "stop") {
			lines.push("");
			lines.push(
				`  stopped: ${r.status} (${r.reason}) · ${r.iterations} iters · ` +
					`${Math.round(r.totalElapsedMs / 1000)}s`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function runLoopLog(argv: string[], io: LoopLogIO = defaultIO): number {
	const verb = argv[0];
	if (!verb || verb === "-h" || verb === "--help") {
		(verb ? io.out : io.err)(LOOP_LOG_HELP);
		return verb ? 0 : 2;
	}
	try {
		const p = parseFlags(verb, argv.slice(1));
		const cwd = resolve(p.flags.cwd ?? ".");
		if (verb === "start") {
			const res = startLoop(cwd, {
				scope: req(p, "scope", verb),
				task: req(p, "task", verb),
				maxIterations: intFlag(p, "max-iterations", verb),
				loopId: p.flags["loop-id"],
				force: p.bools.has("force"),
			});
			io.out(`${JSON.stringify(res)}\n`);
			return 0;
		}
		if (verb === "append") {
			const res = appendIteration(cwd, req(p, "loop-id", verb), {
				implementSummary: req(p, "summary", verb),
				changedFiles: parseChangedFiles(req(p, "changed-files", verb)),
				checksRun: req(p, "checks-run", verb),
				verdict: req(p, "verdict", verb) as LoopVerdict,
				findingCount: intFlag(p, "finding-count", verb),
				decision: req(p, "decision", verb) as LoopVerdict,
				checkDurationMs: intFlag(p, "duration-ms", verb),
				detailsRef: p.flags["details-ref"],
			});
			io.out(`${JSON.stringify(res)}\n`);
			return 0;
		}
		if (verb === "stop") {
			const res = stopLoop(cwd, req(p, "loop-id", verb), {
				status: req(p, "status", verb) as LoopStopStatus,
				reason: req(p, "reason", verb),
			});
			io.out(`${JSON.stringify(res)}\n`);
			return 0;
		}
		if (verb === "show") {
			const records = readLoop(cwd, req(p, "loop-id", verb));
			io.out(p.bools.has("json") ? `${JSON.stringify(records)}\n` : renderLoop(records));
			return 0;
		}
		throw new UsageError(`unknown subcommand "${verb}" (use start|append|stop|show)`);
	} catch (e) {
		if (e instanceof UsageError) {
			io.err(`chit loop-log: ${e.message}\n`);
			return 2;
		}
		if (e instanceof LoopStoreError || e instanceof LoopLogError) {
			io.err(`chit loop-log: ${e.message}\n`);
			return 1;
		}
		// Any other error (e.g. an unexpected filesystem failure) still exits with
		// a clean `chit loop-log:` message and a non-zero code, not a raw stack.
		io.err(`chit loop-log: ${(e as Error).message}\n`);
		return 1;
	}
}
