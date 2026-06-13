import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { type CheckRunner, fakeCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import { fakeSandboxFactory, gitWorktreeSandboxFactory } from "./sandbox.ts";

let dir: string;

const GRILLER = {
	id: "feature-griller",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false } },
	participants: { griller: { agent: "claude", instructions: "Read-only.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "{{ steps.grill.output }}" },
	],
	output: "out",
};

const REVIEW = {
	id: "impl-review",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-min-cli-"));
	mkdirSync(join(dir, "examples"), { recursive: true });
	writeFileSync(join(dir, "examples", "feature-griller.json"), JSON.stringify(GRILLER));
	writeFileSync(join(dir, "examples", "impl-review.json"), JSON.stringify(REVIEW));
	writeFileSync(
		join(dir, "chit.config.json"),
		JSON.stringify({
			routines: {
				"feature-griller": { manifestPath: "examples/feature-griller.json", description: "Question a feature idea." },
				"impl-review": { manifestPath: "examples/impl-review.json", description: "Implement and review." },
			},
		}),
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(over: { adapter?: Adapter; checkRunner?: CheckRunner; sandboxDiff?: string } = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: CliDeps = {
		cwd: dir,
		adapter: over.adapter ?? fakeAdapter(),
		checkRunner: over.checkRunner ?? fakeCheckRunner(),
		sandboxFactory: fakeSandboxFactory({ diff: over.sandboxDiff ?? "diff --git a/x b/x" }),
		now: () => 0,
		newRunId: () => "run-test",
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	};
	return { deps, out, err };
}

describe("chit routines", () => {
	test("lists both routines with their derived kinds", async () => {
		const { deps, out } = harness();
		expect(await runCli(["routines"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("feature-griller");
		expect(text).toContain("text");
		expect(text).toContain("impl-review");
		expect(text).toContain("loop");
	});
});

describe("chit inspect", () => {
	test("inspects a text routine", async () => {
		const { deps, out } = harness();
		expect(await runCli(["inspect", "feature-griller"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("feature-griller  (text)");
		expect(text).toContain("idea");
		expect(text).toContain("call griller");
	});

	test("inspects a converge routine as ordered steps and notes live sandboxed execution", async () => {
		const { deps, out } = harness();
		expect(await runCli(["inspect", "impl-review"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("call builder");
		expect(text).toContain("check: bun test");
		expect(text).toMatch(/git-worktree sandbox/);
	});

	test("refuses an unknown routine with a helpful error", async () => {
		const { deps, err } = harness();
		expect(await runCli(["inspect", "ghost"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/unknown routine "ghost"/);
	});
});

describe("chit run", () => {
	test("runs a one-shot routine and prints output plus a run id", async () => {
		const { deps, out } = harness({ adapter: fakeAdapter((req) => `GRILLED:${req.prompt}`) });
		expect(await runCli(["run", "feature-griller", "--input", "idea=dark mode"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("GRILLED:Idea: dark mode");
		expect(text).toContain("run run-test");
	});

	test("refuses a missing required input", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "feature-griller"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/missing required input "idea"/);
	});

	test("runs a converge routine in a sandbox as a dry run by default", async () => {
		const { deps, out } = harness({ sandboxDiff: "diff --git a/x b/x\n+change" });
		expect(await runCli(["run", "impl-review", "--input", "task=x"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run converged");
		expect(text).toContain("diff --git");
		expect(text).toMatch(/dry run -- sandbox discarded/);
	});

	test("applies a converged converge run with --apply", async () => {
		const { deps, out } = harness();
		expect(await runCli(["run", "impl-review", "--input", "task=x", "--apply"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/applied to/);
	});

	test("rejects a malformed --input", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "feature-griller", "--input", "idea"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/--input expects/);
	});
});

describe("chit trace", () => {
	test("traces a run after it has executed", async () => {
		const run = harness({ adapter: fakeAdapter(() => "report body") });
		await runCli(["run", "feature-griller", "--input", "idea=x"], run.deps);

		const { deps, out } = harness();
		expect(await runCli(["trace", "run-test"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run-test  feature-griller  completed");
		expect(text).toContain("call griller");
		expect(text).not.toContain("report body"); // receipt summarizes, no transcript body
	});

	test("refuses an unknown run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["trace", "nope"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/no run "nope" found/);
	});
});

describe("chit cleanup", () => {
	const temps: string[] = [];
	afterAll(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});

	test("reports when there are no stale sandboxes (non-git cwd)", async () => {
		const { deps, out } = harness();
		expect(await runCli(["cleanup"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/no stale sandboxes/);
	});

	test("removes a leftover sandbox in a git repo and reports it", async () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-cli-clean-"));
		temps.push(repo);
		const sh = (cmd: string) => {
			const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: repo });
			if (r.exitCode !== 0) throw new Error(`${cmd}: ${new TextDecoder().decode(r.stderr)}`);
		};
		sh("git init -q && git config user.email t@t.co && git config user.name tester");
		writeFileSync(join(repo, "a.txt"), "hi\n");
		sh("git add -A && git commit -q -m init");

		// leave an orphaned sandbox behind: created, then its owning process exits
		const sb = await gitWorktreeSandboxFactory.create(repo, "leak");
		const ghost = Bun.spawn(["sh", "-c", "exit 0"]);
		const deadPid = ghost.pid;
		await ghost.exited;
		writeFileSync(join(dirname(sb.workDir), "owner.pid"), String(deadPid));

		const { deps, out } = harness();
		deps.cwd = repo;
		expect(await runCli(["cleanup"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/removed 1 stale sandbox/);
		expect(existsSync(sb.workDir)).toBe(false);
	});
});

describe("chit help", () => {
	test("prints usage with no args", async () => {
		const { deps, out } = harness();
		expect(await runCli([], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/chit routines/);
	});
});
