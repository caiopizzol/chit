// The whole public surface: routines | inspect | run | trace. One concept
// (routine), four verbs. Everything below is wiring the read/run/trace flows to
// the modules; the CLI itself holds no model logic.
//
// `runCli` takes its world as deps (cwd, adapter, clock, id, output sinks) so it
// is testable end-to-end on real config/manifest files with a fake adapter -- no
// real model calls in tests.

import { type AdapterRegistry, dispatchingAdapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { runConverge } from "./converge.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { loadConfig } from "./config.ts";
import { type DoctorProbes, formatDoctor, makeRealAdapterProbe, realDoctorProbes, runDoctor } from "./doctor.ts";
import { resolveFlow, runFlow } from "./flow.ts";
import { validateInputs } from "./inputs.ts";
import { isComposition, isSandboxed, kindLabel } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";
import { runOneShot } from "./run.ts";
import { scaffoldRoutine, type Template, TEMPLATES } from "./scaffold.ts";
import { ApplyError, DirtyWorktreeError, reapStaleSandboxes, type SandboxFactory } from "./sandbox.ts";
import { hasPatch, listReceipts, loadPatch, loadReceipt, savePatch, saveReceipt } from "./store.ts";
import { formatInspect, formatRoutineList, formatRunList, formatTrace, type RoutineListItem, type RunListItem } from "./views.ts";

export interface CliDeps {
	cwd: string;
	// Real adapters keyed by adapter type (e.g. { claude: claudeCliAdapter }). The run
	// command builds a dispatching adapter from this + the config's agent bindings, so a
	// participant's agent id picks the adapter and model.
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
}

const USAGE = `chit -- run declared routines

  chit init [<name>] [--template text|loop|check]   scaffold a runnable inline routine
  chit routines                       list the routines declared in chit.config.json
  chit runs [--scope <name>]          list past runs (id, routine, status, scope, age)
  chit inspect <routine>              show what a routine needs and what it will run
  chit doctor [--real]                check the environment is ready (--real makes tiny model calls)
  chit run <routine> [opts]           run a routine; a sandboxed routine is a DRY RUN (review, then chit apply)
      --input <name>=<value>          supply an input (repeatable)
      --scope <name>                  tag the run (e.g. a Linear/Jira id); read it back with chit runs --scope
      --auto-apply                    automation: apply immediately, skipping the dry-run review (prefer chit apply)
  chit trace <run-id>                 show the receipt for a past run
  chit apply <run-id>                 apply a past sandboxed run's reviewed patch to your tree
  chit cleanup                        remove sandbox worktrees left by interrupted runs

A routine is a declared workflow. The config can keep small routines inline or
point a routine at a file. How it runs is derived from the shape -- routine steps
compose, a repeat loops, and a read-write agent or a check runs it in a sandbox.`;

function parseRunArgs(rest: string[]): {
	id?: string;
	inputs: Record<string, string>;
	scope?: string;
	apply: boolean;
	error?: string;
} {
	const inputs: Record<string, string> = {};
	let id: string | undefined;
	let scope: string | undefined;
	let apply = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--input") {
			const pair = rest[++i];
			if (pair === undefined || !pair.includes("=")) {
				return { id, inputs, apply, error: "--input expects <name>=<value>" };
			}
			const eq = pair.indexOf("=");
			inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else if (a === "--scope") {
			scope = rest[++i];
			if (scope === undefined) return { id, inputs, apply, error: "--scope expects a value" };
		} else if (a === "--auto-apply") {
			apply = true;
		} else if (a?.startsWith("--")) {
			return { id, inputs, apply, error: `unknown option ${a}` };
		} else if (id === undefined) {
			id = a;
		} else {
			return { id, inputs, apply, error: `unexpected argument ${JSON.stringify(a)}` };
		}
	}
	return { id, inputs, apply, ...(scope !== undefined && { scope }) };
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
	const [command, ...rest] = argv;

	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		deps.out(USAGE);
		return 0;
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
			deps.out(args.template === "text" ? runHint : `${runHint}            # dry run by default; review, then: chit apply <run-id>`);
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
					return { id, kind: "?", description: entry.description ?? "(manifest error -- run `chit inspect` for detail)" };
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
			const items: RunListItem[] = listReceipts(deps.cwd)
				.filter((r) => scope === undefined || r.scope === scope)
				.map((r) => ({
					runId: r.runId,
					routineId: r.routineId,
					status: r.status,
					...(r.scope !== undefined && { scope: r.scope }),
					ageMs: now - r.startedAt,
					inputKeys: Object.keys(r.inputs),
					hasPatch: hasPatch(deps.cwd, r.runId),
				}));
			deps.out(formatRunList(items, scope));
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
			const report = await runDoctor(deps.cwd, deps.doctorProbes ?? realDoctorProbes, adapterProbe);
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
			// and model for that participant's agent id.
			const adapter = dispatchingAdapter(config.agents, deps.adapters);

			const validation = validateInputs(routine.manifest, args.inputs);
			if (!validation.ok) {
				for (const e of validation.errors) deps.err(`input error: ${e}`);
				return 1;
			}

			if (isComposition(routine.manifest)) {
				let resolvedFlow: ReturnType<typeof resolveFlow>;
				try {
					resolvedFlow = resolveFlow(routine, (id) => resolveRoutine(config, id, deps.cwd));
				} catch (e) {
					return fail(deps, (e as Error).message);
				}
				// If the flow has a sandboxed (writing) terminal step, refuse a dirty origin now --
				// before grill/plan run -- and capture the base commit for the receipt.
				let flowBase: string | undefined;
				if (resolvedFlow.steps.some((st) => st.kind === "routine" && isSandboxed(st.routine.manifest))) {
					const pf = await preflightSandbox(deps);
					if (!pf.ok) return 1;
					flowBase = pf.baseCommit;
				}
				const result = await runFlow(
					resolvedFlow,
					validation.values,
					{
						adapter,
						checkRunner: deps.checkRunner,
						sandboxFactory: deps.sandboxFactory,
						cwd: deps.cwd,
						now: deps.now,
						newRunId: deps.newRunId,
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
						...(deps.signal !== undefined && { signal: deps.signal }),
						...(deps.askUser !== undefined && { askUser: deps.askUser }),
						...(flowBase !== undefined && { baseCommit: flowBase }),
						apply: args.apply,
					},
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				saveReceipt(deps.cwd, result.receipt);
				for (const sub of result.subReceipts) saveReceipt(deps.cwd, sub);
				if (result.terminalPatch !== undefined && result.terminalPatch.trim() !== "" && result.receipt.status === "completed") savePatch(deps.cwd, result.receipt.runId, result.terminalPatch);
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
						deps.err(`\nrun ${r.runId} completed, but could not apply to your tree: ${result.applyError}  (chit trace ${r.runId})`);
						return 1;
					}
					deps.out(
						result.applied
							? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
							: `\ndry run -- the diff above is saved. apply exactly it with:  chit apply ${r.runId}`,
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
				if (!pf.ok) return 1;
				const result = await runConvergeInSandbox(
					routine,
					validation.values,
					{
						sandboxFactory: deps.sandboxFactory,
						adapter,
						checkRunner: deps.checkRunner,
						cwd: deps.cwd,
						now: deps.now,
						newRunId: deps.newRunId,
						baseCommit: pf.baseCommit,
						...(routine.defaults?.maxIterations !== undefined && { maxIterations: routine.defaults.maxIterations }),
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
						...(deps.signal !== undefined && { signal: deps.signal }),
						apply: args.apply,
					},
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				saveReceipt(deps.cwd, result.receipt);
				// Store the exact patch so `chit apply <run-id>` can re-play this reviewed diff.
				if (result.receipt.status === "converged" && result.patch.trim() !== "") savePatch(deps.cwd, result.receipt.runId, result.patch);
				const r = result.receipt;
				deps.out(`run ${r.status} (${r.iterations.length} iteration${r.iterations.length === 1 ? "" : "s"})`);
				deps.out(result.diff.trim() ? `\n${result.diff}` : "\n(no changes produced)");
				if (r.status === "converged") {
					if (result.applyError !== undefined) {
						deps.err(`\nrun ${r.runId} converged, but could not apply to your tree: ${result.applyError}  (chit trace ${r.runId})`);
						return 1;
					}
					deps.out(
						result.applied
							? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
							: `\ndry run -- the diff above is saved. apply exactly it with:  chit apply ${r.runId}`,
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
				const loop = await runConverge(
					routine,
					validation.values,
					{
						adapter,
						checkRunner: deps.checkRunner,
						cwd: deps.cwd,
						now: deps.now,
						newRunId: deps.newRunId,
						...(routine.defaults?.maxIterations !== undefined && { maxIterations: routine.defaults.maxIterations }),
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
						...(deps.signal !== undefined && { signal: deps.signal }),
					},
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				saveReceipt(deps.cwd, loop);
				deps.out(`run ${loop.status} (${loop.iterations.length} iteration${loop.iterations.length === 1 ? "" : "s"})`);
				if (loop.status === "converged") {
					if (loop.output !== undefined) deps.out(`\n${loop.output}`);
					deps.out(`\nrun ${loop.runId}  (chit trace ${loop.runId})`);
					return 0;
				}
				deps.err(`\nrun ${loop.runId} ${loop.status}${loop.error ? `: ${loop.error}` : ""}`);
				return loop.status === "cancelled" ? 130 : 1;
			}

			const receipt = await runOneShot(routine, validation.values, { ...deps, adapter }, args.scope !== undefined ? { scope: args.scope } : {});
			saveReceipt(deps.cwd, receipt);

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
		}

		if (command === "trace") {
			const id = rest[0];
			if (id === undefined) return fail(deps, "trace needs a run id");
			deps.out(formatTrace(loadReceipt(deps.cwd, id)));
			return 0;
		}

		if (command === "apply") {
			// Apply EXACTLY the patch a prior dry run produced (and the operator reviewed),
			// rather than re-running the models. The sandbox gate checks base + clean tree.
			const id = rest[0];
			if (id === undefined) return fail(deps, "apply needs a run id");
			const receipt = loadReceipt(deps.cwd, id); // throws a clear error if the run is unknown
			const base = "baseCommit" in receipt ? receipt.baseCommit : undefined;
			if (base === undefined) return fail(deps, `run ${JSON.stringify(id)} is not a sandboxed run, so there is nothing to apply`);
			const patch = loadPatch(deps.cwd, id);
			if (patch === undefined || patch.trim() === "") {
				return fail(deps, `run ${JSON.stringify(id)} has no stored patch to apply (it produced no changes, or did not converge)`);
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

// A sandboxed run starts from HEAD, so refuse upfront if the origin is dirty (and capture the
// base commit for the receipt). Called BEFORE any model call, so a flow with a dirty tree fails
// fast rather than after grilling/planning. A clean refusal prints just the guidance, no "error:".
async function preflightSandbox(deps: CliDeps): Promise<{ ok: true; baseCommit: string } | { ok: false }> {
	try {
		const { baseCommit } = await deps.sandboxFactory.preflight(deps.cwd);
		return { ok: true, baseCommit };
	} catch (e) {
		if (e instanceof DirtyWorktreeError) {
			deps.err(e.detail);
			return { ok: false };
		}
		throw e;
	}
}
