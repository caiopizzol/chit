// The whole public surface: routines | inspect | run | trace. One concept
// (routine), four verbs. Everything below is wiring the read/run/trace flows to
// the modules; the CLI itself holds no model logic.
//
// `runCli` takes its world as deps (cwd, adapter, clock, id, output sinks) so it
// is testable end-to-end on real config/manifest files with a fake adapter -- no
// real model calls in tests.

import type { Adapter } from "./adapter.ts";
import { loadConfig } from "./config.ts";
import { validateInputs } from "./inputs.ts";
import { resolveRoutine } from "./routine.ts";
import { runOneShot } from "./run.ts";
import { saveReceipt, loadReceipt } from "./store.ts";
import { formatInspect, formatRoutineList, formatTrace, type RoutineListItem } from "./views.ts";

export interface CliDeps {
	cwd: string;
	adapter: Adapter;
	now: () => number;
	newRunId: () => string;
	out: (line: string) => void;
	err: (line: string) => void;
}

const USAGE = `chit -- run declared routines

  chit routines                       list the routines declared in chit.config.json
  chit inspect <routine>              show what a routine needs and what it will run
  chit run <routine> [opts]           run a routine and print its output
      --input <name>=<value>          supply an input (repeatable)
      --scope <name>                  name the run's scope (session grouping)
  chit trace <run-id>                 show the receipt for a past run

A routine is a declared workflow. Its manifest is the source of truth for inputs,
participants, steps, and policy; config only names it.`;

function parseRunArgs(rest: string[]): { id?: string; inputs: Record<string, string>; scope?: string; error?: string } {
	const inputs: Record<string, string> = {};
	let id: string | undefined;
	let scope: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--input") {
			const pair = rest[++i];
			if (pair === undefined || !pair.includes("=")) {
				return { id, inputs, error: "--input expects <name>=<value>" };
			}
			const eq = pair.indexOf("=");
			inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else if (a === "--scope") {
			scope = rest[++i];
			if (scope === undefined) return { id, inputs, error: "--scope expects a value" };
		} else if (a?.startsWith("--")) {
			return { id, inputs, error: `unknown option ${a}` };
		} else if (id === undefined) {
			id = a;
		} else {
			return { id, inputs, error: `unexpected argument ${JSON.stringify(a)}` };
		}
	}
	return { id, inputs, ...(scope !== undefined && { scope }) };
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
					return { id, policy: r.manifest.policy, description: r.description };
				} catch {
					// A broken manifest should not hide the rest of the menu.
					return { id, policy: "one-shot" as const, description: entry.description ?? "(manifest error -- run `chit inspect` for detail)" };
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

			if (routine.manifest.policy !== "one-shot") {
				// The step-based converge executor exists and is proven under test, but the
				// live CLI does not run it yet: a read-write step edits files unsandboxed, and
				// that write-safety slice is deliberately next. `inspect` shows the loop.
				deps.err(
					`routine ${JSON.stringify(args.id)} is converge. Its executor works (see tests), but live \`chit run\` is gated until the write-safety slice. Try \`chit inspect ${args.id}\`.`,
				);
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
