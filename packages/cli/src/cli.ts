// CLI command wiring around one core concept: routines. Everything below routes
// config, run, receipt, live-process, and sandbox operations to the modules; the
// CLI itself holds no model logic.
//
// `runCli` takes its world as deps (cwd, adapter, clock, id, output sinks) so it
// is testable end-to-end on real config/manifest files with a fake adapter -- no
// real model calls in tests.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type AdapterRegistry, dispatchingAdapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { loadConfig } from "./config.ts";
import { runConverge } from "./converge.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import {
	type DoctorProbes,
	type DoctorRuntime,
	formatDoctor,
	makeRealAdapterProbe,
	realDoctorProbes,
	runDoctor,
} from "./doctor.ts";
import { formatElapsed } from "./elapsed.ts";
import { createRunEventSink, initRunEvents, type RunEvent, type RunEventSink, readRunEvents } from "./events.ts";
import { type ResolvedFlow, resolveFlow, runFlow } from "./flow.ts";
import { validateInputs } from "./inputs.ts";
import {
	type LiveProcess,
	type LiveRun,
	listLiveRuns,
	loadLiveRun,
	realLiveProcess,
	registerLiveRun,
	stopLiveRun,
	unregisterLiveRun,
} from "./live.ts";
import { isComposition, isSandboxed, kindLabel, type Manifest, type Step } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";
import { runOneShot } from "./run.ts";
import { finishedStateFromReceipt, liveRunState, type RunState, readRunState, receiptExitCode } from "./runstate.ts";
import { ApplyError, DirtyWorktreeError, reapStaleSandboxes, type SandboxFactory } from "./sandbox.ts";
import { scaffoldRoutine, TEMPLATES, type Template } from "./scaffold.ts";
import {
	type AnyReceipt,
	listReceipts,
	loadDebugPatch,
	loadPatch,
	loadReceipt,
	loadRunLog,
	patchStatus,
	prepareRunLog,
	removeRunArgv,
	saveDebugPatch,
	savePatch,
	saveReceipt,
	saveRunArgv,
	tryLoadReceipt,
} from "./store.ts";
import {
	formatInspect,
	formatLiveRunList,
	formatReceiptBodies,
	formatRoutineList,
	formatRunList,
	formatRunStatus,
	formatTrace,
	type LiveRunListItem,
	type RoutineListItem,
	type RunListItem,
} from "./views.ts";

export interface BackgroundProcess {
	pid: number;
}

export interface BackgroundSpawner {
	spawn(args: string[], opts: { cwd: string; env: Record<string, string> }): BackgroundProcess;
}

export interface CliDeps {
	cwd: string;
	// Value of the CHIT_PROJECT env var, if set (the bin wires it). A global `--project <path>`
	// arg takes precedence; both resolve the project dir relative to `cwd` and override it, so an
	// agent can run any command from any directory. Omitted means "use cwd".
	projectEnv?: string;
	// Real adapters keyed by adapter type (e.g. { claude: claudeCliAdapter }). The run
	// command builds a dispatching adapter from this + the config's profile bindings, so a
	// routine agent's profile id picks the adapter and model.
	adapters: AdapterRegistry;
	// For sandboxed routines: the check seam and the write-safety sandbox.
	checkRunner: CheckRunner;
	sandboxFactory: SandboxFactory;
	now: () => number;
	newRunId: () => string;
	out: (line: string) => void;
	err: (line: string) => void;
	// Live-progress sink: notable events as they happen (the bin prints to stderr).
	onProgress?: (line: string) => void;
	// Operator-cancellation signal (Ctrl-C). Threaded into every executor; a cancelled
	// run still writes a receipt and exits 130.
	signal?: AbortSignal;
	// Human-input seam for `ask` steps (the bin reads stdin; tests inject an answer).
	// Threaded into the one-shot and flow executors; the sandbox path has no ask steps.
	askUser?: (question: string) => Promise<string>;
	// Environment probes for `chit doctor` (CLI presence, git state). The bin wires the real
	// ones; tests inject a fake. Falls back to the real probes when omitted.
	doctorProbes?: DoctorProbes;
	// Runtime identity for diagnostics. The bin wires the real package version and entrypoint.
	runtime?: DoctorRuntime;
	// Live-process seam for ps/stop/wait. The bin uses real processes; tests inject fakes.
	liveProcess?: LiveProcess;
	// Sleep seam for `chit wait`.
	sleep?: (ms: number) => Promise<void>;
	// Background-process seam for `chit run --background`.
	backgroundSpawner?: BackgroundSpawner;
}

const USAGE = `chit -- run declared routines

  chit init [<name>] [--template text|loop|check]   scaffold a runnable routine
  chit routines                       list the routines declared in chit.config.json
  chit runs [--scope <name>]          list past runs (id, routine, status, scope, age)
  chit ps [--json]                    list currently running runs for this repo
  chit status <run-id> [--json]       show one run's state, live or finished
  chit wait <run-id> [--json] [--follow]   wait until a live run writes its receipt
  chit stop <run-id> [--force]        ask a live run to stop (--force sends SIGKILL)
  chit inspect <routine>              show what a routine needs and what it will run
  chit doctor [--real]                check the environment is ready (--real makes tiny model calls)
  chit run <routine> [opts]           run a routine; a sandboxed routine is a DRY RUN (review, then chit apply)
      --input <name>=<value>          supply an input (repeatable)
      --scope <name>                  tag the run (e.g. a Linear/Jira id); read it back with chit runs --scope
      --auto-apply                    automation: apply immediately, skipping the dry-run review (prefer chit apply)
      --background                    start in another Chit process; use chit wait <run-id>
  chit trace <run-id> [--full]        show a past run's receipt (--full adds the stored inputs + output)
  chit apply <run-id>                 apply a past sandboxed run's reviewed patch to your tree
  chit cleanup                        remove sandbox worktrees left by interrupted runs
  chit --version [--verbose]          print the installed version, plus entrypoint with --verbose

Global: --project <path> (or CHIT_PROJECT) points any command at another project dir,
so an agent can run from any cwd. ps, status, and wait take --json for machine-readable state.

A routine is a declared workflow. How it runs is derived from the shape: routine
steps compose, a repeat loops, and a read-write agent or a check runs it in a sandbox.

Run \`chit help <command>\` or \`chit <command> --help\` for detail on one command.`;

// Focused help for the common commands, printed by `chit <command> --help|-h`
// and `chit help <command>`.
const COMMAND_HELP: Record<string, string> = {
	init: `chit init [<name>] [--template text|loop|check]

Scaffold a runnable routine and register it in chit.config.json (created if absent).

  <name>                routine id (default: example)
  --template text       a read-only one-shot (a model call, no sandbox)
  --template loop       a converging loop (default check writes a file in a sandbox)
  --template check      a single sandboxed pass gated on a check

Then: chit inspect <name>, then chit run <name>.`,
	run: `chit run <routine> [options]

Run a routine. How it runs is derived from its shape: a read-only call/loop runs in your
cwd; a routine that writes files or runs checks runs in a disposable git sandbox and is a
DRY RUN by default (it produces a patch and stops; review, then chit apply).

  --input <name>=<value>   supply an input (repeatable)
  --scope <name>           tag the run (e.g. a Linear/Jira id); read back with chit runs --scope
  --auto-apply             apply immediately, skipping the dry-run review (prefer chit apply)
  --background             start in another Chit process and return once the run has accepted
                           and pinned its base commit; follow it with chit wait <run-id>

A sandboxed run refuses a dirty tree (it starts from HEAD). --background cannot be combined
with --auto-apply, and cannot run a routine that has an ask step.`,
	wait: `chit wait <run-id> [--json] [--follow]

Wait for a live run (usually one started with chit run --background) to finish, streaming
its phase and progress changes plus a heartbeat while it runs, then print its receipt. The
exit code mirrors the run: 0 if it completed/converged, 1 if it failed, 130 if it cancelled.
--json streams nothing to stdout and prints one final run-state object instead; the exit code
is unchanged. --follow (requires --json) streams the run's lifecycle events as JSONL on stdout
as they arrive, then the final run-state object as the last line.`,
	ps: `chit ps [--json]

List the runs currently live for this repo (id, routine, pid, age, cwd). Stale entries whose
process is gone are pruned as they are listed. --json prints an array of run-state objects.`,
	status: `chit status <run-id> [--json]

Show one run's state, whether it is still live or already finished, derived from the receipt,
the live registry, and the lifecycle events. The phase is starting, running, finished, or
orphaned; a finished run also carries its receipt status. --json prints the run-state object
for an agent to read. Exits 1 only when the run id is unknown.`,
	stop: `chit stop <run-id> [--force]

Ask a live run to stop. By default sends SIGTERM, so the run cancels at its next step and
still writes a receipt. --force sends SIGKILL (no receipt, may leave a sandbox for chit cleanup).`,
	runs: `chit runs [--scope <name>]

List past runs (id, routine, status, scope, age, patch state). --scope filters to runs tagged
with that scope. Patch state reflects whether a sandboxed run's stored patch is still appliable.`,
	routines: `chit routines

List the routines declared in chit.config.json with their derived kind (text, loop, sandbox,
flow). A routine whose manifest cannot be read still appears, marked with the error.`,
	inspect: `chit inspect <routine>

Show what a routine needs and what it will run: its inputs, steps, derived kind, limits, and
the agent/model each call resolves to. Reads config and the manifest; runs nothing.`,
	trace: `chit trace <run-id> [--full]

Show a past run's receipt: status, timeline, the model each step ran on, and checks. --full
also prints the stored inputs, final output, and patch. Receipts never store model transcripts.`,
	apply: `chit apply <run-id>

Apply the exact patch a prior sandboxed dry run produced (the one you reviewed) to your tree,
without re-running the models. Refuses unless HEAD still equals the run's base and the tree is
clean, so you apply precisely the reviewed diff.`,
	doctor: `chit doctor [--real]

Check the environment is ready: required agent CLIs on PATH, git state, and config validity.
--real additionally makes a tiny call per configured adapter to prove credentials work.`,
	cleanup: `chit cleanup

Remove sandbox worktrees left behind by interrupted runs. Skips any sandbox whose owning run
is still alive, so it is safe to run while other runs are in progress.`,
};

function parseRunArgs(rest: string[]): {
	id?: string;
	inputs: Record<string, string>;
	scope?: string;
	apply: boolean;
	background: boolean;
	error?: string;
} {
	const inputs: Record<string, string> = {};
	let id: string | undefined;
	let scope: string | undefined;
	let apply = false;
	let background = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--input") {
			const pair = rest[++i];
			if (pair === undefined || !pair.includes("=")) {
				return { id, inputs, apply, background, error: "--input expects <name>=<value>" };
			}
			const eq = pair.indexOf("=");
			inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else if (a === "--scope") {
			scope = rest[++i];
			if (scope === undefined) return { id, inputs, apply, background, error: "--scope expects a value" };
		} else if (a === "--auto-apply") {
			apply = true;
		} else if (a === "--background") {
			background = true;
		} else if (a?.startsWith("--")) {
			return { id, inputs, apply, background, error: `unknown option ${a}` };
		} else if (id === undefined) {
			id = a;
		} else {
			return { id, inputs, apply, background, error: `unexpected argument ${JSON.stringify(a)}` };
		}
	}
	return { id, inputs, apply, background, ...(scope !== undefined && { scope }) };
}

// Pull the global `--project <path>` / `--project=<path>` option out of argv wherever it appears,
// so every command accepts it without each per-command parser needing to know it. Everything else
// passes through untouched in `rest`.
function extractGlobalOpts(argv: string[]): { project?: string; rest: string[]; error?: string } {
	const rest: string[] = [];
	let project: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--project") {
			const value = argv[++i];
			if (value === undefined) return { rest, error: "--project expects a path" };
			project = value;
		} else if (a.startsWith("--project=")) {
			project = a.slice("--project=".length);
			if (project === "") return { rest, error: "--project expects a path" };
		} else {
			rest.push(a);
		}
	}
	return { ...(project !== undefined && { project }), rest };
}

function parseInitArgs(rest: string[]): { name: string; template: Template; error?: string } {
	let name: string | undefined;
	let template: Template = "text";
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--template") {
			const t = rest[++i];
			if (t === undefined || !TEMPLATES.includes(t as Template)) {
				return { name: name ?? "example", template, error: `--template must be one of: ${TEMPLATES.join(", ")}` };
			}
			template = t as Template;
		} else if (a?.startsWith("--")) {
			return { name: name ?? "example", template, error: `unknown option ${a}` };
		} else if (name === undefined) {
			name = a;
		} else {
			return { name, template, error: `unexpected argument ${JSON.stringify(a)}` };
		}
	}
	return { name: name ?? "example", template };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const globals = extractGlobalOpts(argv);
	if (globals.error !== undefined) return fail(deps, globals.error);
	const [command, ...rest] = globals.rest;

	if (command === "--version" || command === "-v" || command === "version") {
		const unknown = rest.find((a) => a !== "--verbose");
		if (unknown !== undefined) return fail(deps, `unknown option ${unknown} (chit --version accepts --verbose)`);
		deps.out(`chit ${deps.runtime?.version ?? "unknown"}`);
		if (rest.includes("--verbose") && deps.runtime?.entrypoint !== undefined) {
			deps.out(`entrypoint ${deps.runtime.entrypoint}`);
		}
		return 0;
	}

	// Subcommand help must short-circuit before each parser validates required args.
	if (command === "help" && rest[0] !== undefined && COMMAND_HELP[rest[0]] !== undefined) {
		deps.out(COMMAND_HELP[rest[0]] as string);
		return 0;
	}
	if (
		command !== undefined &&
		COMMAND_HELP[command] !== undefined &&
		(rest.includes("--help") || rest.includes("-h"))
	) {
		deps.out(COMMAND_HELP[command] as string);
		return 0;
	}

	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		deps.out(USAGE);
		return 0;
	}

	// Project addressing applies only after project-independent commands have exited.
	// A stale CHIT_PROJECT should not make `chit --help` or `chit --version` fail.
	const projectArg = globals.project ?? deps.projectEnv;
	if (projectArg !== undefined && projectArg !== "") {
		const projectDir = resolve(deps.cwd, projectArg);
		if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
			return fail(deps, `project path not found: ${projectDir}`);
		}
		deps = { ...deps, cwd: projectDir };
	}

	try {
		if (command === "init") {
			const args = parseInitArgs(rest);
			if (args.error) return fail(deps, args.error);
			const result = scaffoldRoutine(deps.cwd, args.name, args.template);
			deps.out(`created ${result.routineRef}  (${result.template} routine)`);
			deps.out(`${result.createdConfig ? "created" : "updated"} chit.config.json`);
			deps.out("");
			deps.out("next:");
			deps.out(`  chit inspect ${args.name}`);
			const runHint = `  chit run ${args.name}${result.inputHint ? ` ${result.inputHint}` : ""}`;
			deps.out(
				args.template === "text"
					? runHint
					: `${runHint}            # dry run by default; review, then: chit apply <run-id>`,
			);
			deps.out(`\nedit ${result.routineRef} to make it yours (prompts, agents, checks).`);
			return 0;
		}

		if (command === "routines") {
			const config = loadConfig(deps.cwd);
			const items: RoutineListItem[] = Object.entries(config.routines).map(([id, entry]) => {
				try {
					const r = resolveRoutine(config, id, deps.cwd);
					return { id, kind: kindLabel(r.manifest), description: r.description };
				} catch {
					// A broken manifest should not hide the rest of the menu.
					return {
						id,
						kind: "?",
						description: entry.description ?? "(manifest error -- run `chit inspect` for detail)",
					};
				}
			});
			deps.out(formatRoutineList(items));
			return 0;
		}

		if (command === "runs") {
			let scope: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i];
				if (a === "--scope") {
					scope = rest[++i];
					if (scope === undefined) return fail(deps, "--scope expects a value");
				} else {
					return fail(deps, `unknown option ${a} (chit runs accepts --scope <name>)`);
				}
			}
			const now = deps.now();
			const items: RunListItem[] = await Promise.all(
				listReceipts(deps.cwd)
					.filter((r) => scope === undefined || r.scope === scope)
					.map(async (r) => ({
						runId: r.runId,
						routineId: r.routineId,
						status: r.status,
						...(r.scope !== undefined && { scope: r.scope }),
						ageMs: now - r.startedAt,
						inputs: r.inputs,
						patch: await patchStatus(
							deps.cwd,
							r.runId,
							"baseCommit" in r ? r.baseCommit : undefined,
							"appliedAt" in r ? r.appliedAt : undefined,
						),
					})),
			);
			deps.out(formatRunList(items, scope));
			return 0;
		}

		if (command === "ps") {
			let json = false;
			for (const a of rest) {
				if (a === "--json") json = true;
				else return fail(deps, `unexpected argument ${JSON.stringify(a)}`);
			}
			const now = deps.now();
			const runs = listLiveRuns(deps.cwd, deps.liveProcess);
			if (json) {
				// Each live run rendered through the shared read model, so the JSON is the same state
				// contract status/wait expose -- not a ps-only shape.
				const states = await Promise.all(
					runs.map((r) =>
						readRunState(deps.cwd, r.runId, {
							now,
							...(deps.liveProcess !== undefined && { process: deps.liveProcess }),
						}),
					),
				);
				printJson(
					deps,
					states.filter((s): s is RunState => s !== undefined),
				);
				return 0;
			}
			const items: LiveRunListItem[] = runs.map((r) => ({
				runId: r.runId,
				routineId: r.routineId,
				pid: r.pid,
				ageMs: now - r.startedAt,
				cwd: r.cwd,
			}));
			deps.out(formatLiveRunList(items));
			return 0;
		}

		if (command === "status") {
			let id: string | undefined;
			let json = false;
			for (const a of rest) {
				if (a === "--json") json = true;
				else if (a.startsWith("--")) return fail(deps, `unknown option ${a} (chit status accepts --json)`);
				else if (id === undefined) id = a;
				else return fail(deps, `unexpected argument ${JSON.stringify(a)}`);
			}
			if (id === undefined) return fail(deps, "status needs a run id");
			const state = await readRunState(deps.cwd, id, {
				now: deps.now(),
				...(deps.liveProcess !== undefined && { process: deps.liveProcess }),
			});
			if (state === undefined) return fail(deps, `no run ${JSON.stringify(id)} found`);
			if (json) printJson(deps, state);
			else deps.out(formatRunStatus(state));
			return 0;
		}

		if (command === "wait") {
			let id: string | undefined;
			let json = false;
			let follow = false;
			for (const a of rest) {
				if (a === "--json") json = true;
				else if (a === "--follow") follow = true;
				else if (a.startsWith("--")) return fail(deps, `unknown option ${a} (chit wait accepts --json, --follow)`);
				else if (id === undefined) id = a;
				else return fail(deps, `unexpected argument ${JSON.stringify(a)}`);
			}
			if (id === undefined) return fail(deps, "wait needs a run id");
			// --follow is the structured stream, so it only makes sense alongside --json; there is no
			// human follow format (plain wait already streams progress to stderr).
			if (follow && !json) return fail(deps, "chit wait --follow requires --json");
			return await waitForRun(deps, id, json, follow);
		}

		if (command === "stop") {
			let id: string | undefined;
			let force = false;
			for (const a of rest) {
				if (a === "--force") force = true;
				else if (a.startsWith("--")) return fail(deps, `unknown option ${a} (chit stop accepts --force)`);
				else if (id === undefined) id = a;
				else return fail(deps, `unexpected argument ${JSON.stringify(a)}`);
			}
			if (id === undefined) return fail(deps, "stop needs a run id");
			const result = stopLiveRun(deps.cwd, id, { force, process: deps.liveProcess });
			if (!result.ok) return fail(deps, result.message);
			deps.out(`sent ${result.signal} to ${result.run.runId} (pid ${result.run.pid})`);
			return 0;
		}

		if (command === "inspect") {
			const id = rest[0];
			if (id === undefined) return fail(deps, "inspect needs a routine id");
			const config = loadConfig(deps.cwd);
			deps.out(formatInspect(resolveRoutine(config, id, deps.cwd)));
			return 0;
		}

		if (command === "doctor") {
			const unknown = rest.find((a) => a !== "--real");
			if (unknown !== undefined) return fail(deps, `unknown option ${unknown} (chit doctor accepts --real)`);
			const adapterProbe = rest.includes("--real") ? makeRealAdapterProbe(deps.adapters) : undefined;
			const report = await runDoctor(deps.cwd, deps.doctorProbes ?? realDoctorProbes, {
				...(adapterProbe !== undefined && { adapterProbe }),
				...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
				...(deps.runtime !== undefined && { runtime: deps.runtime }),
			});
			deps.out(formatDoctor(report));
			return report.ok ? 0 : 1;
		}

		if (command === "run") {
			const args = parseRunArgs(rest);
			if (args.error) return fail(deps, args.error);
			if (args.id === undefined) return fail(deps, "run needs a routine id");
			const config = loadConfig(deps.cwd);
			const routine = resolveRoutine(config, args.id, deps.cwd);
			// One adapter for the executors; it routes each call to the configured adapter
			// and model for that routine agent's profile id.
			const adapter = dispatchingAdapter(config.agents, deps.adapters);

			const validation = validateInputs(routine.manifest, args.inputs);
			if (!validation.ok) {
				for (const e of validation.errors) deps.err(`input error: ${e}`);
				return 1;
			}

			let resolvedFlow: ResolvedFlow | undefined;
			if (isComposition(routine.manifest)) {
				try {
					resolvedFlow = resolveFlow(routine, (id) => resolveRoutine(config, id, deps.cwd));
				} catch (e) {
					return fail(deps, (e as Error).message);
				}
			}

			if (args.background) {
				if (deps.backgroundSpawner === undefined) {
					return fail(deps, "this Chit entrypoint cannot start background runs");
				}
				if (args.apply) {
					return fail(deps, "--background cannot be combined with --auto-apply; use chit wait, then chit apply");
				}
				const askReason = backgroundAskReason(routine.id, routine.manifest.steps, resolvedFlow);
				if (askReason !== undefined)
					return fail(deps, `--background cannot run routines with ask steps (${askReason})`);
				if (needsSandboxPreflight(routine.manifest, resolvedFlow)) {
					const pf = await preflightSandbox(deps);
					if (!pf.ok) return 1;
				}
				return await startBackgroundRun(deps, routine.id, backgroundRunArgv(routine.id, args));
			}

			const live = liveRunContext(deps, routine.id);
			try {
				if (isComposition(routine.manifest)) {
					if (resolvedFlow === undefined) {
						const msg = `could not resolve composition ${JSON.stringify(routine.id)}`;
						live.events.failed(msg);
						return fail(deps, msg);
					}
					// If the flow has a sandboxed (writing) terminal step, refuse a dirty origin now
					// before grill/plan run, and capture the base commit for the receipt.
					let flowBase: string | undefined;
					if (needsSandboxPreflight(routine.manifest, resolvedFlow)) {
						const pf = await preflightSandbox(deps);
						if (!pf.ok) {
							live.events.failed(pf.detail);
							return 1;
						}
						flowBase = pf.baseCommit;
					}
					// The background parent can return once the origin is accepted.
					live.events.ready(flowBase);
					const result = await runFlow(
						resolvedFlow,
						validation.values,
						{
							adapter,
							checkRunner: deps.checkRunner,
							sandboxFactory: deps.sandboxFactory,
							cwd: deps.cwd,
							now: deps.now,
							newRunId: live.newRunId,
							onProgress: live.onProgress,
							...(deps.signal !== undefined && { signal: deps.signal }),
							...(deps.askUser !== undefined && { askUser: deps.askUser }),
							...(flowBase !== undefined && { baseCommit: flowBase }),
							apply: args.apply,
						},
						args.scope !== undefined ? { scope: args.scope } : {},
					);
					if (result.applied === true) result.receipt.appliedAt = deps.now();
					recordRunFinished(deps, live, result.receipt);
					for (const sub of result.subReceipts) saveReceipt(deps.cwd, sub);
					if (result.terminalPatch !== undefined && result.terminalPatch.trim() !== "") {
						if (result.receipt.status === "completed") {
							savePatch(deps.cwd, result.receipt.runId, result.terminalPatch);
						} else {
							saveDebugPatch(deps.cwd, result.receipt.runId, result.terminalPatch);
						}
					}
					const r = result.receipt;
					deps.out(`flow: ${r.status} (${r.steps.length} step${r.steps.length === 1 ? "" : "s"})`);
					for (const s of r.steps) deps.out(`  ${s.id} -> ${s.kind === "ask" ? "ask" : s.routine}: ${s.status}`);
					if (r.status === "cancelled") {
						deps.err(`\nrun ${r.runId} cancelled.  (chit trace ${r.runId})`);
						return 130;
					}
					if (r.status === "failed") {
						deps.err(`\nrun ${r.runId} failed: ${r.error ?? "(unknown)"}`);
						return 1;
					}
					if (result.terminalDiff !== undefined) {
						deps.out(result.terminalDiff.trim() ? `\n${result.terminalDiff}` : "\n(no changes produced)");
						if (result.applyError !== undefined) {
							deps.err(
								`\nrun ${r.runId} completed, but could not apply to your tree: ${result.applyError}  (chit trace ${r.runId})`,
							);
							return 1;
						}
						deps.out(
							result.applied
								? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
								: `\ndry run -- the diff is saved.\n  review:  chit trace --full ${r.runId}\n  apply:   chit apply ${r.runId}`,
						);
						return 0;
					}
					const lastSub = result.subReceipts.at(-1);
					if (lastSub !== undefined && "output" in lastSub && lastSub.output !== undefined) {
						deps.out(`\n${lastSub.output}`);
					}
					deps.out(`\nrun ${r.runId}  (chit trace ${r.runId})`);
					return 0;
				}

				if (isSandboxed(routine.manifest)) {
					// A routine that writes or runs checks executes inside a sandbox (a git
					// worktree): edits land on the copy, not your tree. Dry run by default
					// (show the diff, discard it); review then `chit apply`, or `--auto-apply` to skip review.
					const pf = await preflightSandbox(deps);
					if (!pf.ok) {
						live.events.failed(pf.detail);
						return 1;
					}
					// The sandbox will be cut from this commit, so later local edits cannot affect it.
					live.events.ready(pf.baseCommit);
					const result = await runConvergeInSandbox(
						routine,
						validation.values,
						{
							sandboxFactory: deps.sandboxFactory,
							adapter,
							checkRunner: deps.checkRunner,
							cwd: deps.cwd,
							now: deps.now,
							newRunId: live.newRunId,
							baseCommit: pf.baseCommit,
							...(routine.defaults?.maxIterations !== undefined && { maxIterations: routine.defaults.maxIterations }),
							onProgress: live.onProgress,
							...(deps.signal !== undefined && { signal: deps.signal }),
							apply: args.apply,
						},
						args.scope !== undefined ? { scope: args.scope } : {},
					);
					if (result.applied === true) result.receipt.appliedAt = deps.now();
					recordRunFinished(deps, live, result.receipt);
					// Store the exact patch so `chit apply <run-id>` can re-play this reviewed diff.
					// Non-converged/failed runs get a .debug.patch for inspection, not an applyable .patch.
					if (result.patch.trim() !== "") {
						if (result.debugPatch) {
							saveDebugPatch(deps.cwd, result.receipt.runId, result.patch);
						} else if (result.receipt.status === "converged") {
							savePatch(deps.cwd, result.receipt.runId, result.patch);
						}
					}
					const r = result.receipt;
					deps.out(`run ${r.status} (${r.iterations.length} iteration${r.iterations.length === 1 ? "" : "s"})`);
					deps.out(result.diff.trim() ? `\n${result.diff}` : "\n(no changes produced)");
					if (r.status === "converged") {
						if (result.applyError !== undefined) {
							deps.err(
								`\nrun ${r.runId} converged, but could not apply to your tree: ${result.applyError}  (chit trace ${r.runId})`,
							);
							return 1;
						}
						deps.out(
							result.applied
								? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
								: `\ndry run -- the diff is saved.\n  review:  chit trace --full ${r.runId}\n  apply:   chit apply ${r.runId}`,
						);
						return 0;
					}
					deps.err(`\nrun ${r.runId} ${r.status}${r.error ? `: ${r.error}` : ""}`);
					return r.status === "cancelled" ? 130 : 1;
				}

				if (routine.manifest.repeat !== undefined) {
					// A non-sandboxed loop: read-only, no checks, but a `repeat` whose exit is a
					// { step, equals } condition (e.g. an evaluator returns "yes"). It writes nothing,
					// so it loops in the cwd with no worktree; its result is text, printed like a one-shot.
					// No base commit to accept (read-only), so readiness just marks "running".
					live.events.ready();
					const loop = await runConverge(
						routine,
						validation.values,
						{
							adapter,
							checkRunner: deps.checkRunner,
							cwd: deps.cwd,
							now: deps.now,
							newRunId: live.newRunId,
							...(routine.defaults?.maxIterations !== undefined && { maxIterations: routine.defaults.maxIterations }),
							onProgress: live.onProgress,
							...(deps.signal !== undefined && { signal: deps.signal }),
						},
						args.scope !== undefined ? { scope: args.scope } : {},
					);
					recordRunFinished(deps, live, loop);
					deps.out(
						`run ${loop.status} (${loop.iterations.length} iteration${loop.iterations.length === 1 ? "" : "s"})`,
					);
					if (loop.status === "converged") {
						if (loop.output !== undefined) deps.out(`\n${loop.output}`);
						deps.out(`\nrun ${loop.runId}  (chit trace ${loop.runId})`);
						return 0;
					}
					deps.err(`\nrun ${loop.runId} ${loop.status}${loop.error ? `: ${loop.error}` : ""}`);
					return loop.status === "cancelled" ? 130 : 1;
				}

				// A read-only text run touches nothing, so readiness just marks "running".
				live.events.ready();
				const receipt = await runOneShot(
					routine,
					validation.values,
					{ ...deps, adapter, newRunId: live.newRunId, onProgress: live.onProgress },
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				recordRunFinished(deps, live, receipt);

				if (receipt.status === "cancelled") {
					deps.err(`run ${receipt.runId} cancelled.  (chit trace ${receipt.runId})`);
					return 130;
				}
				if (receipt.status === "failed") {
					deps.err(`run ${receipt.runId} failed: ${receipt.error ?? "(unknown)"}`);
					return 1;
				}
				if (receipt.output !== undefined) deps.out(receipt.output);
				deps.out(`\nrun ${receipt.runId}  (chit trace ${receipt.runId})`);
				return 0;
			} finally {
				live.unregister();
			}
		}

		if (command === "trace") {
			let id: string | undefined;
			let full = false;
			for (const a of rest) {
				if (a === "--full") full = true;
				else if (a.startsWith("--")) return fail(deps, `unknown option ${a} (chit trace accepts --full)`);
				else if (id === undefined) id = a;
				else return fail(deps, `unexpected argument ${JSON.stringify(a)}`);
			}
			if (id === undefined) return fail(deps, "trace needs a run id");
			const receipt = loadReceipt(deps.cwd, id);
			deps.out(formatTrace(receipt));
			if (full) deps.out(formatReceiptBodies(receipt, loadPatch(deps.cwd, id), loadDebugPatch(deps.cwd, id)));
			return 0;
		}

		if (command === "apply") {
			// Apply EXACTLY the patch a prior dry run produced (and the operator reviewed),
			// rather than re-running the models. The sandbox gate checks base + clean tree.
			const id = rest[0];
			if (id === undefined) return fail(deps, "apply needs a run id");
			const receipt = loadReceipt(deps.cwd, id); // throws a clear error if the run is unknown
			const base = "baseCommit" in receipt ? receipt.baseCommit : undefined;
			if (base === undefined)
				return fail(deps, `run ${JSON.stringify(id)} is not a sandboxed run, so there is nothing to apply`);
			const patch = loadPatch(deps.cwd, id);
			if (patch === undefined || patch.trim() === "") {
				return fail(
					deps,
					`run ${JSON.stringify(id)} has no stored patch to apply (it produced no changes, or did not converge)`,
				);
			}
			try {
				await deps.sandboxFactory.applyPatch(deps.cwd, patch, base);
			} catch (e) {
				if (e instanceof ApplyError) {
					deps.err(e.detail);
					return 1;
				}
				throw e;
			}
			// Record that Chit applied this patch: a durable "applied" status that survives later commits.
			(receipt as { appliedAt?: number }).appliedAt = deps.now();
			saveReceipt(deps.cwd, receipt);
			deps.out(`applied run ${id} to ${deps.cwd}.  (chit trace ${id})`);
			return 0;
		}

		if (command === "cleanup") {
			const removed = await reapStaleSandboxes(deps.cwd);
			deps.out(
				removed.length > 0
					? `removed ${removed.length} stale sandbox${removed.length === 1 ? "" : "es"}:\n${removed.map((p) => `  ${p}`).join("\n")}`
					: "no stale sandboxes to clean up",
			);
			return 0;
		}

		deps.err(`unknown command ${JSON.stringify(command)}\n`);
		deps.err(USAGE);
		return 2;
	} catch (e) {
		return fail(deps, (e as Error).message);
	}
}

function fail(deps: CliDeps, message: string): number {
	deps.err(`error: ${message}`);
	return 1;
}

// The only thing a `--json` command writes to stdout: one JSON value, nothing else. Progress and
// errors go to stderr, so an agent can parse stdout directly.
function printJson(deps: CliDeps, value: unknown): void {
	deps.out(JSON.stringify(value, null, 2));
}

// One compact JSON value per line: the JSONL contract `wait --follow` streams on stdout (events as
// they arrive, then one final run-state object). Diagnostics still go to stderr, so an agent reads
// stdout line by line.
function printJsonLine(deps: CliDeps, value: unknown): void {
	deps.out(JSON.stringify(value));
}

// Emit a run-state object on the stdout channel a `wait` invocation reserves: a JSONL line when
// following, otherwise the single pretty object plain `--json` prints. Only reached when --json is on.
function emitFinalState(deps: CliDeps, state: RunState, follow: boolean): void {
	if (follow) printJsonLine(deps, state);
	else printJson(deps, state);
}

const WAIT_POLL_MS = 500;
const WAIT_HEARTBEAT_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTail(text: string, limit = 4000): string {
	const trimmed = text.trimEnd();
	if (trimmed.length <= limit) return trimmed;
	return `[truncated]\n${trimmed.slice(trimmed.length - limit)}`;
}

function failWithRunLog(deps: CliDeps, runId: string, message: string): number {
	removeRunArgv(deps.cwd, runId);
	deps.err(`error: ${message}`);
	const log = loadRunLog(deps.cwd, runId);
	if (log !== undefined && log.trim() !== "") {
		deps.err(`\nlast output from ${runId}:\n${logTail(log)}`);
	}
	return 1;
}

async function finishWaitWithReceipt(
	deps: CliDeps,
	runId: string,
	receipt: AnyReceipt,
	json: boolean,
	follow: boolean,
): Promise<number> {
	unregisterLiveRun(deps.cwd, runId);
	removeRunArgv(deps.cwd, runId);
	if (json) emitFinalState(deps, await finishedStateFromReceipt(deps.cwd, receipt), follow);
	else deps.out(formatTrace(receipt));
	return receiptExitCode(receipt);
}

// `wait --json` must still print one state object when a run ends without a receipt (it crashed or
// was force-killed). The diagnostic message + log tail stay on stderr via failWithRunLog.
function failWaitNoReceipt(
	deps: CliDeps,
	runId: string,
	message: string,
	json: boolean,
	follow: boolean,
	live?: LiveRun,
): number {
	if (json) {
		const now = deps.now();
		const state: RunState = {
			runId,
			...(live !== undefined && { routineId: live.routineId }),
			phase: "orphaned",
			done: true,
			exitCode: 1,
			startedAt: live?.startedAt ?? now,
			elapsedMs: live !== undefined ? now - live.startedAt : 0,
			...(live !== undefined && { pid: live.pid, cwd: live.cwd }),
			error: message,
		};
		emitFinalState(deps, state, follow);
	}
	return failWithRunLog(deps, runId, message);
}

function waitEventLine(event: RunEvent): string | undefined {
	if (event.kind === "progress") return event.line;
	if (event.kind === "ready")
		return event.baseCommit !== undefined ? `  base ${event.baseCommit.slice(0, 12)} pinned` : undefined;
	if (event.kind === "failed") return `  startup failed: ${event.error}`;
	// `done` is the structured terminal marker; human wait prints the full receipt next, so it adds no line.
	return undefined;
}

function doneEventFromReceipt(deps: CliDeps, receipt: AnyReceipt): RunEvent {
	return { at: deps.now(), kind: "done", status: receipt.status, exitCode: receiptExitCode(receipt) };
}

async function waitForRun(deps: CliDeps, runId: string, json: boolean, follow: boolean): Promise<number> {
	const sleep = deps.sleep ?? defaultSleep;
	const proc = deps.liveProcess ?? realLiveProcess;
	let cursor = 0;
	let lastActivityAt: number | undefined;
	let doneStreamed = false;
	// Held so a no-receipt failure can still name the run's routine in its JSON object, even after
	// the live entry is unregistered.
	let lastLive: LiveRun | undefined;
	const streamEvents = () => {
		const events = readRunEvents(deps.cwd, runId);
		for (; cursor < events.length; cursor++) {
			const event = events[cursor] as RunEvent;
			if (event.kind === "done") doneStreamed = true;
			if (follow) {
				// --follow turns stdout into the run's JSONL event stream; the final run-state object
				// is appended after the terminal `done` event, so an agent reads one stream end to end.
				printJsonLine(deps, event);
			} else {
				// In --json (non-follow) and human mode stdout is reserved for the one final object, so
				// the human progress lines go to stderr via onProgress.
				const line = waitEventLine(event);
				if (line !== undefined) deps.onProgress?.(line);
			}
			lastActivityAt = deps.now();
		}
	};
	const finishReceiptIfFollowStreamIsTerminal = async (receipt: AnyReceipt): Promise<number | undefined> => {
		streamEvents();
		if (follow && !doneStreamed) {
			const live = loadLiveRun(deps.cwd, runId);
			if (live !== undefined && proc.isAlive(live.pid)) return undefined;
			const done = doneEventFromReceipt(deps, receipt);
			doneStreamed = true;
			printJsonLine(deps, done);
			lastActivityAt = deps.now();
		}
		return await finishWaitWithReceipt(deps, runId, receipt, json, follow);
	};
	for (;;) {
		const receipt = tryLoadReceipt(deps.cwd, runId);
		if (receipt !== undefined) {
			const exit = await finishReceiptIfFollowStreamIsTerminal(receipt);
			if (exit !== undefined) return exit;
			await sleep(WAIT_POLL_MS);
			continue;
		}

		const live = loadLiveRun(deps.cwd, runId);
		if (live !== undefined) lastLive = live;
		if (live === undefined) {
			const finalReceipt = tryLoadReceipt(deps.cwd, runId);
			if (finalReceipt !== undefined) {
				const exit = await finishReceiptIfFollowStreamIsTerminal(finalReceipt);
				if (exit !== undefined) return exit;
				await sleep(WAIT_POLL_MS);
				continue;
			}
			streamEvents();
			return failWaitNoReceipt(
				deps,
				runId,
				`no live run ${JSON.stringify(runId)} found and no receipt exists`,
				json,
				follow,
			);
		}
		if (!proc.isAlive(live.pid)) {
			const finalReceipt = tryLoadReceipt(deps.cwd, runId);
			if (finalReceipt !== undefined) {
				const exit = await finishReceiptIfFollowStreamIsTerminal(finalReceipt);
				if (exit !== undefined) return exit;
				await sleep(WAIT_POLL_MS);
				continue;
			}
			streamEvents();
			unregisterLiveRun(deps.cwd, runId);
			return failWaitNoReceipt(
				deps,
				runId,
				`run ${runId} is no longer running and no receipt was written`,
				json,
				follow,
				lastLive,
			);
		}
		if (deps.signal?.aborted) {
			// The wait was cancelled, not the run -- which is still live. Report the current snapshot
			// so --json ends with one object; the run keeps going and exit 130 + stderr say why.
			streamEvents();
			if (json) emitFinalState(deps, liveRunState(live, readRunEvents(deps.cwd, runId), deps.now()), follow);
			deps.err(`wait for ${runId} cancelled`);
			return 130;
		}
		streamEvents();
		if (lastActivityAt === undefined) lastActivityAt = deps.now();
		else if (deps.now() - lastActivityAt >= WAIT_HEARTBEAT_MS) {
			deps.onProgress?.(`  still waiting on ${runId}... ${formatElapsed(deps.now() - live.startedAt)}`);
			lastActivityAt = deps.now();
		}
		await sleep(WAIT_POLL_MS);
	}
}

function hasAskStep(steps: Step[]): Step | undefined {
	return steps.find((s) => s.kind === "ask");
}

function backgroundAskReason(routineId: string, steps: Step[], flow?: ResolvedFlow): string | undefined {
	const direct = hasAskStep(steps);
	if (direct !== undefined) return `${JSON.stringify(routineId)} step ${JSON.stringify(direct.id)}`;
	if (flow === undefined) return undefined;
	for (const step of flow.steps) {
		if (step.kind === "ask") return `${JSON.stringify(routineId)} composition step ${JSON.stringify(step.id)}`;
		const subAsk = hasAskStep(step.routine.manifest.steps);
		if (subAsk !== undefined) {
			return `${JSON.stringify(routineId)} step ${JSON.stringify(step.id)} calls ${JSON.stringify(step.routine.id)} step ${JSON.stringify(subAsk.id)}`;
		}
	}
	return undefined;
}

function needsSandboxPreflight(manifest: Manifest, flow?: ResolvedFlow): boolean {
	if (flow !== undefined) return flow.steps.some((st) => st.kind === "routine" && isSandboxed(st.routine.manifest));
	return isSandboxed(manifest);
}

function backgroundRunArgv(routineId: string, args: ReturnType<typeof parseRunArgs>): string[] {
	const argv = ["run", routineId];
	for (const [name, value] of Object.entries(args.inputs)) argv.push("--input", `${name}=${value}`);
	if (args.scope !== undefined) argv.push("--scope", args.scope);
	return argv;
}

const BACKGROUND_READY_POLL_MS = 50;

async function startBackgroundRun(deps: CliDeps, routineId: string, argv: string[]): Promise<number> {
	if (deps.backgroundSpawner === undefined) {
		return fail(deps, "this Chit entrypoint cannot start background runs");
	}
	const runId = deps.newRunId();
	const logPath = prepareRunLog(deps.cwd, runId);
	const argvPath = saveRunArgv(deps.cwd, runId, argv);
	let child: BackgroundProcess;
	try {
		child = deps.backgroundSpawner.spawn([], {
			cwd: deps.cwd,
			env: { CHIT_RUN_ID: runId, CHIT_LOG_PATH: logPath, CHIT_ARGV_PATH: argvPath },
		});
	} catch (e) {
		removeRunArgv(deps.cwd, runId);
		throw e;
	}
	registerLiveRun(deps.cwd, {
		runId,
		routineId,
		pid: child.pid,
		startedAt: deps.now(),
		cwd: deps.cwd,
	});
	// Do not report the run as started until the child accepts its origin or fails startup.
	const init = await awaitBackgroundInit(deps, runId, child.pid);
	if (init.status === "failed") {
		unregisterLiveRun(deps.cwd, runId);
		return failWithRunLog(deps, runId, `background run ${runId} could not start: ${init.error}`);
	}
	if (init.status === "interrupted") {
		// The child is detached and may still be initializing.
		deps.err(`\ninterrupted while starting ${runId}; it may still be running.  (chit ps  /  chit wait ${runId})`);
		return 130;
	}
	// A run that already wrote its receipt leaves no live work.
	if (tryLoadReceipt(deps.cwd, runId) !== undefined) unregisterLiveRun(deps.cwd, runId);
	deps.out(`started ${runId} in background (pid ${child.pid})`);
	deps.out(`  wait:  chit wait ${runId}`);
	deps.out("  ps:    chit ps");
	deps.out(`  trace: chit trace ${runId}`);
	return 0;
}

type BackgroundInit = { status: "ready" } | { status: "failed"; error: string } | { status: "interrupted" };

async function awaitBackgroundInit(deps: CliDeps, runId: string, pid: number): Promise<BackgroundInit> {
	const sleep = deps.sleep ?? defaultSleep;
	const proc = deps.liveProcess ?? realLiveProcess;
	for (;;) {
		const events = readRunEvents(deps.cwd, runId);
		if (events.some((e) => e.kind === "ready")) return { status: "ready" };
		const failed = firstFailedError(events);
		if (failed !== undefined) return { status: "failed", error: failed };
		// A receipt proves startup completed, even if the run already finished.
		if (tryLoadReceipt(deps.cwd, runId) !== undefined) return { status: "ready" };
		if (!proc.isAlive(pid)) {
			// Re-read once in case a final event raced in just before process exit.
			const late = firstFailedError(readRunEvents(deps.cwd, runId));
			if (late !== undefined) return { status: "failed", error: late };
			if (tryLoadReceipt(deps.cwd, runId) !== undefined) return { status: "ready" };
			return { status: "failed", error: "the child exited during startup without signalling readiness" };
		}
		if (deps.signal?.aborted) return { status: "interrupted" };
		await sleep(BACKGROUND_READY_POLL_MS);
	}
}

function firstFailedError(events: RunEvent[]): string | undefined {
	for (const e of events) if (e.kind === "failed") return e.error;
	return undefined;
}

interface LiveRunContext {
	events: RunEventSink;
	onProgress: (line: string) => void;
	newRunId: () => string;
	unregister: () => void;
}

// Persist a run's terminal receipt, then mark its event stream `done`. The receipt stays the
// durable source of truth; `wait --follow` waits for this event while the writer is alive and
// synthesizes it only for legacy/crashed-after-receipt streams.
function recordRunFinished(deps: CliDeps, live: LiveRunContext, receipt: AnyReceipt): void {
	saveReceipt(deps.cwd, receipt);
	live.events.done(receipt.status, receiptExitCode(receipt));
}

function liveRunContext(deps: CliDeps, routineId: string): LiveRunContext {
	const runId = deps.newRunId();
	initRunEvents(deps.cwd, runId);
	const events = createRunEventSink(deps.cwd, runId, deps.now);
	let registered = false;
	let topAssigned = false;
	return {
		events,
		onProgress: (line) => {
			deps.onProgress?.(line);
			events.progress(line);
		},
		newRunId: () => {
			if (topAssigned) return deps.newRunId();
			topAssigned = true;
			registered = true;
			registerLiveRun(deps.cwd, { runId, routineId, pid: process.pid, startedAt: deps.now(), cwd: deps.cwd });
			return runId;
		},
		unregister: () => {
			if (registered) unregisterLiveRun(deps.cwd, runId);
		},
	};
}

// A sandboxed run starts from HEAD, so refuse upfront if the origin is dirty (and capture the
// base commit for the receipt). Called BEFORE any model call, so a flow with a dirty tree fails
// fast rather than after grilling/planning. A clean refusal prints just the guidance, no "error:".
async function preflightSandbox(
	deps: CliDeps,
): Promise<{ ok: true; baseCommit: string } | { ok: false; detail: string }> {
	try {
		const { baseCommit } = await deps.sandboxFactory.preflight(deps.cwd);
		return { ok: true, baseCommit };
	} catch (e) {
		if (e instanceof DirtyWorktreeError) {
			deps.err(e.detail);
			return { ok: false, detail: e.detail };
		}
		throw e;
	}
}
