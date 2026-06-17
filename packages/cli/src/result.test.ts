// buildRunResult derives the compact machine contract from a receipt. These tests pin the GENERIC
// model: the declared repeat.until is reported verbatim and each condition is evaluated against the
// final iteration as a signal -- a user-authored verdict/review step is just a `step-json` /
// `step-equals` signal, never a built-in concept. Patch facts are derived live from git, so the
// applyReady / patchPath tests stand up a real repo the way runs.test.ts does.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConvergeReceipt, ConvergeStepReceipt, IterationReceipt } from "./converge.ts";
import type { FlowReceipt } from "./flow.ts";
import type { RepeatUntil } from "./manifest.ts";
import { buildRunResult } from "./result.ts";
import type { RunReceipt } from "./run.ts";
import { saveDebugPatch, savePatch } from "./store.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-result-"));
	dirs.push(d);
	return d;
}

function checkStep(id: string, ok: boolean, command = "bun test"): ConvergeStepReceipt {
	return {
		id,
		kind: "check",
		status: ok ? "ok" : "failed",
		startedAt: 0,
		elapsedMs: 1,
		checks: [{ command, ok, startedAt: 0, elapsedMs: 1 }],
	};
}

function jsonStep(id: string, json: unknown): ConvergeStepReceipt {
	return { id, kind: "call", participant: id, status: "ok", startedAt: 0, elapsedMs: 1, json };
}

function callStep(id: string, output: string): ConvergeStepReceipt {
	return { id, kind: "call", participant: id, status: "ok", startedAt: 0, elapsedMs: 1, output };
}

function iteration(n: number, steps: ConvergeStepReceipt[], met: boolean): IterationReceipt {
	return { n, startedAt: 0, steps, allChecksPassed: met };
}

function convergeReceipt(
	over: Partial<ConvergeReceipt> & Pick<ConvergeReceipt, "until" | "iterations">,
): ConvergeReceipt {
	return {
		runId: "run-r",
		routineId: "implement",
		policy: "converge",
		digest: "digest",
		inputs: { task: "x" },
		maxIterations: 3,
		startedAt: 0,
		finishedAt: 1,
		elapsedMs: 1,
		status: "converged",
		...over,
	};
}

describe("buildRunResult -- convergence signals", () => {
	test("an `all` of checks-pass AND a step-json verdict expands to one signal each, with the structured output", async () => {
		const dir = tmp();
		const until: RepeatUntil = { all: ["checks-pass", { step: "review", path: "passed", equals: true }] };
		const receipt = convergeReceipt({
			until,
			status: "converged",
			iterations: [iteration(1, [jsonStep("review", { passed: true, issues: [] }), checkStep("verify", true)], true)],
		});
		const result = await buildRunResult(dir, receipt);

		expect(result).toMatchObject({
			runId: "run-r",
			routineId: "implement",
			phase: "finished",
			done: true,
			status: "converged",
			exitCode: 0,
		});
		// The declared condition is echoed verbatim -- the agent reads the routine's own contract.
		expect(result.until).toEqual(until);
		expect(result.signals).toEqual([
			{ kind: "checks-pass", passed: true },
			{ kind: "step-json", stepId: "review", path: "passed", equals: true, value: true, passed: true },
		]);
		// The evaluator's structured output is surfaced generically, keyed by its step id.
		expect(result.structuredSteps).toEqual({ review: { passed: true, issues: [] } });
		expect(result.checks).toEqual([{ stepId: "verify", command: "bun test", ok: true }]);
	});

	test("a failing step-json verdict is the signal that did not pass (checks still green)", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			until: { all: ["checks-pass", { step: "review", path: "passed", equals: true }] },
			status: "did-not-converge",
			iterations: [
				iteration(
					1,
					[jsonStep("review", { passed: false, issues: ["scope creep"] }), checkStep("verify", true)],
					false,
				),
			],
		});
		const result = await buildRunResult(dir, receipt);

		expect(result.status).toBe("did-not-converge");
		expect(result.exitCode).toBe(1);
		expect(result.signals).toEqual([
			{ kind: "checks-pass", passed: true },
			{ kind: "step-json", stepId: "review", path: "passed", equals: true, value: false, passed: false },
		]);
		expect(result.nextCommand).toBe("chit trace run-r"); // nothing to apply -> inspect
	});

	test("a text `{ step, equals }` condition reads the step's trimmed output", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			until: { step: "done", equals: "yes" },
			iterations: [iteration(1, [callStep("work", "did the thing"), callStep("done", "yes\n")], true)],
		});
		const result = await buildRunResult(dir, receipt);

		expect(result.until).toEqual({ step: "done", equals: "yes" });
		expect(result.signals).toEqual([
			{ kind: "step-equals", stepId: "done", equals: "yes", value: "yes", passed: true },
		]);
		// A plain text loop declares no checks and no json schema.
		expect(result.checks).toEqual([]);
		expect(result.structuredSteps).toEqual({});
	});

	test("evaluates against the FINAL iteration", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			until: { step: "done", equals: "yes" },
			iterations: [iteration(1, [callStep("done", "no")], false), iteration(2, [callStep("done", "yes")], true)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.signals).toEqual([
			{ kind: "step-equals", stepId: "done", equals: "yes", value: "yes", passed: true },
		]);
	});

	test("a missing step / json field reads as a null value that does not pass", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			until: { all: [{ step: "review", path: "decision.ready", equals: true }] },
			status: "did-not-converge",
			iterations: [iteration(1, [jsonStep("review", { passed: true })], false)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.signals).toEqual([
			{ kind: "step-json", stepId: "review", path: "decision.ready", equals: true, value: null, passed: false },
		]);
	});

	test("a missing text output reads as null and does not satisfy an empty-string target", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			until: { step: "done", equals: "" },
			status: "did-not-converge",
			iterations: [
				iteration(
					1,
					[{ id: "done", kind: "call", participant: "judge", status: "failed", startedAt: 0, elapsedMs: 1 }],
					false,
				),
			],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.signals).toEqual([{ kind: "step-equals", stepId: "done", equals: "", value: null, passed: false }]);
	});

	test("a legacy converge receipt with no `until` defaults to checks-pass", async () => {
		const dir = tmp();
		// Older receipts predate the stored `until`; the builder must still report a coherent contract.
		const receipt = convergeReceipt({
			until: undefined as unknown as ConvergeReceipt["until"],
			iterations: [iteration(1, [checkStep("verify", true)], true)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.until).toBe("checks-pass");
		expect(result.signals).toEqual([{ kind: "checks-pass", passed: true }]);
	});
});

describe("buildRunResult -- apply surface", () => {
	function sh(cwd: string, cmd: string): string {
		const r = Bun.spawnSync(["sh", "-c", cmd], { cwd });
		if (r.exitCode !== 0) throw new Error(`${cmd}: ${new TextDecoder().decode(r.stderr)}`);
		return new TextDecoder().decode(r.stdout);
	}
	function gitRepo(): { dir: string; base: string } {
		const dir = tmp();
		sh(dir, "git init -q && git config user.email t@t.co && git config user.name tester");
		writeFileSync(join(dir, ".gitignore"), ".chit/\n");
		writeFileSync(join(dir, "a.txt"), "hello\n");
		sh(dir, "git add -A && git commit -q -m base");
		return { dir, base: sh(dir, "git rev-parse HEAD").trim() };
	}
	function pendingPatch(dir: string): string {
		writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
		const patch = sh(dir, "git diff");
		sh(dir, "git checkout -- a.txt");
		return patch;
	}

	test("a converged run with a stored patch that applies is applyReady, with a project-relative path and an apply next command", async () => {
		const { dir, base } = gitRepo();
		savePatch(dir, "run-r", pendingPatch(dir));
		const receipt = convergeReceipt({
			runId: "run-r",
			baseCommit: base,
			until: "checks-pass",
			iterations: [iteration(1, [checkStep("verify", true)], true)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.applyReady).toBe(true);
		expect(result.patch).toBe("pending");
		expect(result.patchPath).toBe(".chit/runs/run-r.patch");
		expect(result.debugPatchPath).toBeNull();
		expect(result.nextCommand).toBe("chit apply run-r");
	});

	test("a non-converged run exposes only the debug patch path, never an applyable one", async () => {
		const dir = tmp();
		saveDebugPatch(dir, "run-r", "diff --git a/x b/x\n");
		const receipt = convergeReceipt({
			runId: "run-r",
			status: "did-not-converge",
			until: "checks-pass",
			iterations: [iteration(1, [checkStep("verify", false)], false)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.applyReady).toBe(false);
		expect(result.patch).toBe("none");
		expect(result.patchPath).toBeNull();
		expect(result.debugPatchPath).toBe(".chit/runs/run-r.debug.patch");
		expect(result.signals).toEqual([{ kind: "checks-pass", passed: false }]);
		expect(result.nextCommand).toBe("chit trace run-r");
	});

	test("surfaces a converged-but-apply-failed run's applyError and scope", async () => {
		const dir = tmp();
		const receipt = convergeReceipt({
			scope: "SD-1",
			applyError: "dirty origin",
			until: "checks-pass",
			iterations: [iteration(1, [checkStep("verify", true)], true)],
		});
		const result = await buildRunResult(dir, receipt);
		expect(result.scope).toBe("SD-1");
		expect(result.applyError).toBe("dirty origin");
		expect(result.exitCode).toBe(1); // converged but could not apply -> failure exit
	});
});

describe("buildRunResult -- non-converge receipts degrade", () => {
	test("a one-shot text run has no convergence condition, signals, or checks", async () => {
		const dir = tmp();
		const receipt: RunReceipt = {
			runId: "run-text",
			routineId: "grill",
			policy: "one-shot",
			digest: "digest",
			inputs: { idea: "x" },
			startedAt: 0,
			finishedAt: 1,
			elapsedMs: 1,
			status: "completed",
			steps: [],
			output: "body",
		};
		const result = await buildRunResult(dir, receipt);
		expect(result).toMatchObject({
			runId: "run-text",
			phase: "finished",
			done: true,
			status: "completed",
			exitCode: 0,
		});
		expect(result.until).toBeNull();
		expect(result.signals).toEqual([]);
		expect(result.structuredSteps).toEqual({});
		expect(result.checks).toEqual([]);
		expect(result.patchPath).toBeNull();
		expect(result.nextCommand).toBe("chit trace run-text");
	});

	test("a flow run reports lifecycle facts with an empty convergence surface", async () => {
		const dir = tmp();
		const receipt: FlowReceipt = {
			runId: "run-flow",
			routineId: "feature-flow",
			policy: "flow",
			digest: "digest",
			inputs: { idea: "x" },
			startedAt: 0,
			finishedAt: 1,
			elapsedMs: 1,
			status: "completed",
			steps: [],
		};
		const result = await buildRunResult(dir, receipt);
		expect(result.until).toBeNull();
		expect(result.signals).toEqual([]);
		expect(result.status).toBe("completed");
		expect(result.exitCode).toBe(0);
	});
});
