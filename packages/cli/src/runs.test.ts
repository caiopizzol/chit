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
import { listReceipts, patchStatus, savePatch, saveReceipt } from "./store.ts";
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
	inputs: { idea: "add a hero section" },
	startedAt: 1000,
	finishedAt: 2000,
	elapsedMs: 1000,
	status: "completed",
	steps: [],
	output: "Implementation plan: add shout and whisper helpers",
};
const RUN_B: ConvergeReceipt = {
	runId: "run-bbb",
	routineId: "implement",
	policy: "converge",
	scope: "SD-1",
	digest: "sha256:b",
	inputs: { task: "wire the billing API" },
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
		{ runId: "run-aaa", routineId: "plan", status: "completed", ageMs: 5 * 60_000, inputs: { idea: "add a hero section" }, patch: "none" },
		{ runId: "run-bbb", routineId: "implement", status: "converged", scope: "SD-1", ageMs: 2 * 3_600_000, inputs: { task: "wire the billing API" }, patch: "pending" },
	];

	test("renders newest-first with scope, age, input previews, and a patch tag", () => {
		const text = formatRunList(items);
		expect(text).toContain("runs (2):");
		expect(text.indexOf("run-aaa")).toBeLessThan(text.indexOf("run-bbb")); // 5m ago before 2h ago
		expect(text).toContain("5m ago");
		expect(text).toContain("2h ago");
		expect(text).toContain("SD-1");
		expect(text).toContain("pending"); // run-bbb's derived patch status
		expect(text).toContain("idea: add a hero section"); // the primary input VALUE, not just the key
		expect(text).toContain("task: wire the billing API");
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
		expect(text).toContain("idea: add a hero section"); // the value preview distinguishes runs
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

describe("chit trace --full", () => {
	test("shows the stored input values and the output body", async () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		const { deps, out } = mkDeps(dir);
		expect(await runCli(["trace", "run-aaa", "--full"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("idea: add a hero section");
		expect(text).toContain("Implementation plan: add shout and whisper helpers");
	});

	test("compact by default omits the bodies", async () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		const { deps, out } = mkDeps(dir);
		expect(await runCli(["trace", "run-aaa"], deps)).toBe(0);
		expect(out.join("\n")).not.toContain("Implementation plan: add shout and whisper helpers");
	});

	test("rejects an unknown option", async () => {
		const dir = tmp();
		saveReceipt(dir, RUN_A);
		const { deps, err } = mkDeps(dir);
		expect(await runCli(["trace", "run-aaa", "--xyz"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/unknown option --xyz/);
	});
});

describe("patchStatus (derived from git)", () => {
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
	// A real patch that adds a line to a.txt, generated by git and then reverted, so the tree is
	// clean and the patch is genuinely "pending".
	function pendingPatch(dir: string): string {
		writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
		const patch = sh(dir, "git diff");
		sh(dir, "git checkout -- a.txt");
		return patch;
	}

	test("none when no patch is stored", async () => {
		const { dir, base } = gitRepo();
		expect(await patchStatus(dir, "run-x", base)).toBe("none");
	});

	test("pending when the patch applies cleanly onto the current HEAD", async () => {
		const { dir, base } = gitRepo();
		savePatch(dir, "run-p", pendingPatch(dir));
		expect(await patchStatus(dir, "run-p", base)).toBe("pending");
	});

	test("applied when the patch's changes are already in the tree", async () => {
		const { dir, base } = gitRepo();
		savePatch(dir, "run-p", pendingPatch(dir));
		sh(dir, "git apply .chit/runs/run-p.patch");
		expect(await patchStatus(dir, "run-p", base)).toBe("applied");
	});

	test("blocked when HEAD moved off the recorded base and the patch is unapplied", async () => {
		const { dir, base } = gitRepo();
		savePatch(dir, "run-p", pendingPatch(dir));
		writeFileSync(join(dir, "b.txt"), "other\n");
		sh(dir, "git add -A && git commit -q -m move");
		expect(await patchStatus(dir, "run-p", base)).toBe("blocked");
	});

	test("applied (durable) once appliedAt is recorded, even after HEAD moved and the patch no longer applies", async () => {
		const { dir, base } = gitRepo();
		savePatch(dir, "run-p", pendingPatch(dir));
		writeFileSync(join(dir, "b.txt"), "other\n");
		sh(dir, "git add -A && git commit -q -m move");
		expect(await patchStatus(dir, "run-p", base)).toBe("blocked"); // derived: committed, but the patch no longer applies
		expect(await patchStatus(dir, "run-p", base, 123)).toBe("applied"); // durable: Chit recorded applying it
	});
});
