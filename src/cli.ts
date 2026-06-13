// The whole public surface: routines | inspect | run | trace. One concept
// (routine), four verbs. Everything below is wiring the read/run/trace flows to
// the modules; the CLI itself holds no model logic.
//
// `runCli` takes its world as deps (cwd, adapter, clock, id, output sinks) so it
// is testable end-to-end on real config/manifest files with a fake adapter -- no
// real model calls in tests.

import type { Adapter } from "./adapter.ts";
import type { CheckRunner } from "./check-runner.ts";
import { runConvergeInSandbox } from "./converge-run.ts";
import { loadConfig } from "./config.ts";
import { resolveFlow, runFlow } from "./flow.ts";
import { validateInputs } from "./inputs.ts";
import { isComposition, isSandboxed, kindLabel } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";
import { runOneShot } from "./run.ts";
import { reapStaleSandboxes, type SandboxFactory } from "./sandbox.ts";
import { saveReceipt, loadReceipt } from "./store.ts";
import { formatInspect, formatRoutineList, formatTrace, type RoutineListItem } from "./views.ts";

export interface CliDeps {
	cwd: string;
	adapter: Adapter;
	// For sandboxed routines: the check seam and the write-safety sandbox.
	checkRunner: CheckRunner;
	sandboxFactory: SandboxFactory;
	now: () => number;
	newRunId: () => string;
	out: (line: string) => void;
	err: (line: string) => void;
	// Live-progress sink: notable events as they happen (the bin prints to stderr).
	onProgress?: (line: string) => void;
}

const USAGE = `chit -- run declared routines

  chit routines                       list the routines declared in chit.config.json
  chit inspect <routine>              show what a routine needs and what it will run
  chit run <routine> [opts]           run a routine and print its output
      --input <name>=<value>          supply an input (repeatable)
      --scope <name>                  name the run's scope (session grouping)
      --apply                         (sandboxed routines) apply the result to your tree; default is a dry run
  chit trace <run-id>                 show the receipt for a past run
  chit cleanup                        remove sandbox worktrees left by interrupted runs

A routine is a declared workflow. Its manifest is the source of truth: inputs,
participants, ordered steps, and an optional repeat. Config only names it. How it
runs is derived from the shape -- routine steps compose, a repeat loops, and a
read-write participant or a check runs it in a sandbox.`;

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
		} else if (a === "--apply") {
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

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const [command, ...rest] = argv;

	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		deps.out(USAGE);
		return 0;
	}

	try {
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

		if (command === "inspect") {
			const id = rest[0];
			if (id === undefined) return fail(deps, "inspect needs a routine id");
			const config = loadConfig(deps.cwd);
			deps.out(formatInspect(resolveRoutine(config, id, deps.cwd)));
			return 0;
		}

		if (command === "run") {
			const args = parseRunArgs(rest);
			if (args.error) return fail(deps, args.error);
			if (args.id === undefined) return fail(deps, "run needs a routine id");
			const config = loadConfig(deps.cwd);
			const routine = resolveRoutine(config, args.id, deps.cwd);

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
				const result = await runFlow(
					resolvedFlow,
					validation.values,
					{
						adapter: deps.adapter,
						checkRunner: deps.checkRunner,
						sandboxFactory: deps.sandboxFactory,
						cwd: deps.cwd,
						now: deps.now,
						newRunId: deps.newRunId,
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
						apply: args.apply,
					},
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				saveReceipt(deps.cwd, result.receipt);
				for (const sub of result.subReceipts) saveReceipt(deps.cwd, sub);
				const r = result.receipt;
				deps.out(`flow: ${r.status} (${r.steps.length} step${r.steps.length === 1 ? "" : "s"})`);
				for (const s of r.steps) deps.out(`  ${s.id} -> ${s.routine}: ${s.status}`);
				if (r.status === "failed") {
					deps.err(`\nrun ${r.runId} failed: ${r.error ?? "(unknown)"}`);
					return 1;
				}
				if (result.terminalDiff !== undefined) {
					deps.out(result.terminalDiff.trim() ? `\n${result.terminalDiff}` : "\n(no changes produced)");
					deps.out(
						result.applied
							? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
							: `\ndry run -- sandbox discarded. re-run with --apply to keep these changes.  run ${r.runId}`,
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
				// (show the diff, discard it); `--apply` writes the result back.
				const result = await runConvergeInSandbox(
					routine,
					validation.values,
					{
						sandboxFactory: deps.sandboxFactory,
						adapter: deps.adapter,
						checkRunner: deps.checkRunner,
						cwd: deps.cwd,
						now: deps.now,
						newRunId: deps.newRunId,
						...(routine.defaults?.maxIterations !== undefined && { maxIterations: routine.defaults.maxIterations }),
						...(deps.onProgress !== undefined && { onProgress: deps.onProgress }),
						apply: args.apply,
					},
					args.scope !== undefined ? { scope: args.scope } : {},
				);
				saveReceipt(deps.cwd, result.receipt);
				const r = result.receipt;
				deps.out(`run ${r.status} (${r.iterations.length} iteration${r.iterations.length === 1 ? "" : "s"})`);
				deps.out(result.diff.trim() ? `\n${result.diff}` : "\n(no changes produced)");
				if (r.status === "converged") {
					deps.out(
						result.applied
							? `\napplied to ${deps.cwd}.  run ${r.runId}  (chit trace ${r.runId})`
							: `\ndry run -- sandbox discarded. re-run with --apply to keep these changes.  run ${r.runId}`,
					);
					return 0;
				}
				deps.err(`\nrun ${r.runId} ${r.status}${r.error ? `: ${r.error}` : ""}`);
				return 1;
			}

			const receipt = await runOneShot(routine, validation.values, deps, args.scope !== undefined ? { scope: args.scope } : {});
			saveReceipt(deps.cwd, receipt);

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
