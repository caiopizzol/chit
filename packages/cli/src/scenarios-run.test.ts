// Executes the scenario matrix end-to-end, not just "does the config resolve" (that is
// scenarios.test.ts). Each scenario runs its entry routine through the real CLI dispatch
// (`runCli`) so the text / flow / loop / sandbox paths are all exercised.
//
// Two modes:
//   fake (default, CI): fake adapter + fake check runner + fake sandbox. Deterministic and
//     free. The fakes are scripted just enough to reach each routine's intended terminal
//     state: the verdict a judged loop waits for, a check that fails once then passes, an
//     operator answer for the human gate. Exit 0 is the proof a scenario ran to success.
//   real (guarded, CHIT_REAL=1): selected read-only scenarios against the installed CLIs.
//     Skipped by default -- it spends real model calls and needs auth. `chit doctor --real`
//     will later be the gate that says whether this can run.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCliAdapter, codexCliAdapter, fakeAdapter, geminiCliAdapter } from "./adapter.ts";
import { argvCheckRunner, fakeCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import { fakeSandboxFactory, gitWorktreeSandboxFactory } from "./sandbox.ts";
import { loadPatch } from "./store.ts";

const scenariosDir = join(process.cwd(), "test/scenarios");
const temps: string[] = [];
afterAll(() => {
	for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// Run a scenario in a throwaway copy so receipts (.chit) never land in the committed dir.
function copyScenario(name: string): string {
	const dest = mkdtempSync(join(tmpdir(), `chit-scn-${name.replace(/\W/g, "")}-`));
	temps.push(dest);
	cpSync(join(scenariosDir, name), dest, { recursive: true });
	return dest;
}

interface Plan {
	dir: string;
	// The entry routine to run (some scenarios declare several; this is the one a user runs).
	routine: string;
	inputs?: Record<string, string>;
	// What every fake model call returns. For a judged loop this must equal the verdict the
	// loop waits for; otherwise "ok" (the value is just text feeding forward).
	reply?: string;
	// Default: every check passes. "fail-then-pass" makes the first check fail and the rest
	// pass, the shape that proves a loop re-runs and recovers (scenario 09).
	checks?: "fail-then-pass";
}

const PLANS: Plan[] = [
	{ dir: "01-clarify", routine: "clarify" },
	{ dir: "02-grill", routine: "grill", inputs: { idea: "add dark mode" } },
	{ dir: "03-plan", routine: "plan", inputs: { goal: "ship onboarding" } },
	{ dir: "04-panel-review", routine: "panel-review", inputs: { question: "is this migration safe?" } },
	{ dir: "05-refine-loop", routine: "refine", inputs: { brief: "draft the README intro" }, reply: "ship" },
	{ dir: "06-implementation-loop", routine: "implement", inputs: { task: "add a --version flag" } },
	{ dir: "07-feature-flow", routine: "feature-flow", inputs: { idea: "add dark mode" }, reply: "pass" },
	{ dir: "08-review-blocks-loop", routine: "implement", inputs: { task: "add a --version flag" }, reply: "pass" },
	{ dir: "09-check-fails-then-recovers", routine: "forced-revise", checks: "fail-then-pass" },
	{
		dir: "10-cross-run-handoff",
		routine: "implement-with-context",
		inputs: { task: "apply the review", context: "prior run output" },
	},
];

function runArgs(plan: Plan): string[] {
	const args = ["run", plan.routine];
	for (const [k, v] of Object.entries(plan.inputs ?? {})) args.push("--input", `${k}=${v}`);
	return args;
}

function fakeDeps(cwd: string, plan: Plan) {
	const out: string[] = [];
	const err: string[] = [];
	const adapter = fakeAdapter(() => plan.reply ?? "ok");
	const checkRunner =
		plan.checks === "fail-then-pass"
			? fakeCheckRunner((_check, i) => ({ ok: i > 0, exitCode: i > 0 ? 0 : 1, output: i > 0 ? "" : "not yet" }))
			: fakeCheckRunner();
	let n = 0;
	const deps: CliDeps = {
		cwd,
		adapters: { claude: adapter, gemini: adapter, codex: adapter },
		checkRunner,
		sandboxFactory: fakeSandboxFactory({ diff: "diff --git a/x b/x\n+change" }),
		now: () => 0,
		newRunId: () => `run-${n++}`,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		askUser: async () => "ok",
	};
	return { deps, out, err, checkRunner };
}

describe("scenario matrix executes end-to-end (fake mode)", () => {
	for (const plan of PLANS) {
		test(`${plan.dir}: ${plan.routine} runs to success`, async () => {
			const cwd = copyScenario(plan.dir);
			const { deps } = fakeDeps(cwd, plan);
			const code = await runCli(runArgs(plan), deps);
			expect(code).toBe(0);
		});
	}

	test("09 actually re-runs: the check fails once, then the loop converges", async () => {
		const plan = PLANS.find((p) => p.dir === "09-check-fails-then-recovers");
		if (!plan) throw new Error("missing plan 09");
		const cwd = copyScenario(plan.dir);
		const { deps, checkRunner } = fakeDeps(cwd, plan);
		expect(await runCli(runArgs(plan), deps)).toBe(0);
		expect(checkRunner.calls.length).toBeGreaterThanOrEqual(2);
	});

	test("06 sandboxed loop stores the exact patch for chit apply (dry run)", async () => {
		const plan = PLANS.find((p) => p.dir === "06-implementation-loop");
		if (!plan) throw new Error("missing plan 06");
		const cwd = copyScenario(plan.dir);
		const { deps } = fakeDeps(cwd, plan);
		expect(await runCli(runArgs(plan), deps)).toBe(0);
		expect(loadPatch(cwd, "run-0")).toBeTruthy();
	});
});

// Selected read-only scenarios against the real CLIs. Guarded: runs only with CHIT_REAL=1,
// because it spends real model calls and needs the adapters installed and authed.
const REAL = process.env.CHIT_REAL === "1";
const realTest = REAL ? test : test.skip;

describe("scenario matrix against real CLIs (guarded by CHIT_REAL=1)", () => {
	for (const dir of ["02-grill", "03-plan"]) {
		const plan = PLANS.find((p) => p.dir === dir);
		realTest(`${dir} runs against the installed CLIs`, async () => {
			if (!plan) throw new Error(`missing plan ${dir}`);
			const cwd = copyScenario(dir);
			let n = 0;
			const deps: CliDeps = {
				cwd,
				adapters: { claude: claudeCliAdapter, gemini: geminiCliAdapter, codex: codexCliAdapter },
				checkRunner: argvCheckRunner,
				sandboxFactory: gitWorktreeSandboxFactory,
				now: () => Date.now(),
				newRunId: () => `run-real-${n++}`,
				out: () => {},
				err: () => {},
				askUser: async () => "ok",
			};
			expect(await runCli(runArgs(plan), deps)).toBe(0);
		});
	}
});
