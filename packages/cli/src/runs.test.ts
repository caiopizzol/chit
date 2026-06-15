import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import type { ConvergeReceipt } from "./converge.ts";
import type { RunReceipt } from "./run.ts";
import { fakeSandboxFactory } from "./sandbox.ts";
import { listReceipts, saveReceipt } from "./store.ts";
import { formatRunList, type RunListItem } from "./views.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-runs-"));
	dirs.push(d);
	return d;
}

const RUN_A: RunReceipt = {
	runId: "run-aaa",
	routineId: "plan",
	policy: "one-shot",
	digest: "sha256:a",
	inputs: { idea: "x" },
	startedAt: 1000,
	finishedAt: 2000,
	elapsedMs: 1000,
	status: "completed",
	steps: [],
};
const RUN_B: ConvergeReceipt = {
	runId: "run-bbb",
	routineId: "implement",
	policy: "converge",
	scope: "SD-1",
	digest: "sha256:b",
	inputs: { task: "x" },
	maxIterations: 3,
	until: "checks-pass",
	startedAt: 1500,
	finishedAt: 3000,
	elapsedMs: 1500,
	status: "converged",
	iterations: [],
};

describe("listReceipts", () => {
	test("reads every receipt, skipping .patch siblings and corrupt files", () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		saveReceipt(dir, RUN_B);
		writeFileSync(join(dir, ".chit", "runs", "run-aaa.patch"), "diff --git a/x b/x");
		writeFileSync(join(dir, ".chit", "runs", "broken.json"), "{ not json");
		expect(
			listReceipts(dir)
				.map((r) => r.runId)
				.sort(),
		).toEqual(["run-aaa", "run-bbb"]);
	});

	test("returns [] when there are no runs", () => {
		expect(listReceipts(tmp())).toEqual([]);
	});
});

describe("formatRunList", () => {
	const items: RunListItem[] = [
		{ runId: "run-aaa", routineId: "plan", status: "completed", ageMs: 5 * 60_000, inputKeys: ["idea"], hasPatch: false },
		{ runId: "run-bbb", routineId: "implement", status: "converged", scope: "SD-1", ageMs: 2 * 3_600_000, inputKeys: ["task"], hasPatch: true },
	];

	test("renders newest-first with scope, age, inputs, and a patch tag", () => {
		const text = formatRunList(items);
		expect(text).toContain("runs (2):");
		expect(text.indexOf("run-aaa")).toBeLessThan(text.indexOf("run-bbb")); // 5m ago before 2h ago
		expect(text).toContain("5m ago");
		expect(text).toContain("2h ago");
		expect(text).toContain("SD-1");
		expect(text).toContain("patch"); // run-bbb has a stored patch
	});

	test("empty and scope-filtered messages", () => {
		expect(formatRunList([])).toContain("No runs yet");
		expect(formatRunList([], "SD-9")).toContain('No runs found for scope "SD-9"');
	});

	test("uses a scope header when filtering", () => {
		const only = items[1];
		if (!only) throw new Error("fixture");
		expect(formatRunList([only], "SD-1")).toContain('runs in scope "SD-1" (1):');
	});
});

function mkDeps(cwd: string): { deps: CliDeps; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const deps: CliDeps = {
		cwd,
		adapters: { claude: fakeAdapter() },
		checkRunner: fakeCheckRunner(),
		sandboxFactory: fakeSandboxFactory(),
		now: () => 10_000,
		newRunId: () => "run-x",
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	};
	return { deps, out, err };
}

describe("chit runs (command)", () => {
	test("lists the stored runs", async () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		saveReceipt(dir, RUN_B);
		const { deps, out } = mkDeps(dir);
		expect(await runCli(["runs"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run-aaa");
		expect(text).toContain("run-bbb");
	});

	test("--scope filters to one work item", async () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		saveReceipt(dir, RUN_B);
		const { deps, out } = mkDeps(dir);
		expect(await runCli(["runs", "--scope", "SD-1"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run-bbb");
		expect(text).not.toContain("run-aaa");
	});

	test("rejects an unknown option instead of ignoring it", async () => {
		const { deps, err } = mkDeps(tmp());
		expect(await runCli(["runs", "--bogus"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/unknown option --bogus/);
	});

	test("reports when there are no runs yet", async () => {
		const { deps, out } = mkDeps(tmp());
		expect(await runCli(["runs"], deps)).toBe(0);
		expect(out.join("\n")).toContain("No runs yet");
	});
});
