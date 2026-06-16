import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { type CheckRunner, fakeCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import type { ConvergeReceipt } from "./converge.ts";
import { fakeSandboxFactory, gitWorktreeSandboxFactory } from "./sandbox.ts";
import { loadReceipt } from "./store.ts";

let dir: string;

const GRILLER = {
	id: "feature-griller",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false } },
	agents: { griller: { profile: "claude", instructions: "Read-only.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "{{ steps.grill.output }}" },
	],
	output: "out",
};

const REVIEW = {
	id: "impl-review",
	inputs: { task: { type: "string" } },
	agents: {
		builder: { profile: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { profile: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
};

// A non-sandboxed loop: read-only worker + evaluator, a { step, equals } exit. No checks,
// no writes -> it loops in the cwd, never a worktree. The /goal pattern, user-authored.
const GOAL = {
	id: "goal-loop",
	inputs: { goal: { type: "string" } },
	agents: {
		worker: { profile: "claude", instructions: "Work toward the goal.", filesystem: "read-only" },
		judge: { profile: "judge", instructions: "Decide if the goal is met.", filesystem: "read-only" },
	},
	steps: [
		{ id: "work", call: "worker", prompt: "Goal {{ inputs.goal }} prev=[{{ steps.done.output }}]" },
		{ id: "done", call: "judge", prompt: "Met? {{ steps.work.output }}" },
	],
	repeat: { until: { step: "done", equals: "yes" }, maxIterations: 3 },
	output: "work",
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-min-cli-"));
	mkdirSync(join(dir, "examples"), { recursive: true });
	writeFileSync(join(dir, "examples", "feature-griller.json"), JSON.stringify(GRILLER));
	writeFileSync(join(dir, "examples", "impl-review.json"), JSON.stringify(REVIEW));
	writeFileSync(join(dir, "examples", "goal-loop.json"), JSON.stringify(GOAL));
	writeFileSync(
		join(dir, "chit.config.json"),
		JSON.stringify({
			routines: {
				"feature-griller": { file: "examples/feature-griller.json", description: "Question a feature idea." },
				"impl-review": { file: "examples/impl-review.json", description: "Implement and review." },
				"goal-loop": { file: "examples/goal-loop.json", description: "Loop until an evaluator says yes." },
			},
			// impl-review's two routine agents use different profile ids ("codex" / "claude"); both
			// resolve to the claude adapter here, proving per-agent profile binding.
			profiles: {
				claude: { adapter: "claude", model: "default" },
				codex: { adapter: "claude", model: "default" },
				judge: { adapter: "claude", model: "default" },
			},
		}),
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(
	over: { adapter?: Adapter; checkRunner?: CheckRunner; sandboxDiff?: string; applyError?: string; onApplyPatch?: (patch: string, base: string) => void } = {},
) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: CliDeps = {
		cwd: dir,
		adapters: { claude: over.adapter ?? fakeAdapter() },
		checkRunner: over.checkRunner ?? fakeCheckRunner(),
		sandboxFactory: fakeSandboxFactory({
			diff: over.sandboxDiff ?? "diff --git a/x b/x",
			...(over.applyError !== undefined && { applyError: over.applyError }),
			...(over.onApplyPatch !== undefined && { onApplyPatch: over.onApplyPatch }),
		}),
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
		expect(text).toMatch(/dry run/);
		expect(text).toMatch(/chit trace --full run-test/); // review hint
		expect(text).toMatch(/chit apply run-test/); // apply hint
	});

	test("applies a converged run immediately with --auto-apply", async () => {
		const { deps, out } = harness();
		expect(await runCli(["run", "impl-review", "--input", "task=x", "--auto-apply"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/applied to/);
	});

	test("a sandboxed run records the base commit (from preflight) on its receipt", async () => {
		const { deps } = harness();
		expect(await runCli(["run", "impl-review", "--input", "task=x"], deps)).toBe(0);
		const receipt = loadReceipt(dir, "run-test") as ConvergeReceipt;
		expect(receipt.baseCommit).toBe("base0000"); // the fake factory's preflight base
	});

	test("rejects a malformed --input", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "feature-griller", "--input", "idea"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/--input expects/);
	});

	test("runs a non-sandboxed loop in the cwd and prints its text result on convergence", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "yes" : `draft:${req.prompt}`));
		const { deps, out } = harness({ adapter });
		expect(await runCli(["run", "goal-loop", "--input", "goal=ship"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run converged (1 iteration)");
		expect(text).toContain("draft:"); // the worker's output, not the "yes" verdict
		expect(text).not.toMatch(/sandbox discarded/); // proves the cwd-loop path, not the sandbox path
	});

	test("a non-sandboxed loop that never meets its condition exits 1", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "no" : "draft"));
		const { deps, err } = harness({ adapter });
		expect(await runCli(["run", "goal-loop", "--input", "goal=ship"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/did-not-converge/);
	});
});

describe("chit run live progress", () => {
	test("reports elapsed as each call completes (one-shot)", async () => {
		const { deps } = harness({ adapter: fakeAdapter(() => "x") });
		let clock = 0;
		deps.now = () => (clock += 1000);
		const progress: string[] = [];
		deps.onProgress = (l) => progress.push(l);
		await runCli(["run", "feature-griller", "--input", "idea=x"], deps);
		expect(progress.some((l) => /call griller done in/.test(l))).toBe(true);
	});

	test("reports call and check elapsed (sandboxed loop)", async () => {
		const { deps } = harness({ sandboxDiff: "diff --git a/x b/x" });
		let clock = 0;
		deps.now = () => (clock += 1000);
		const progress: string[] = [];
		deps.onProgress = (l) => progress.push(l);
		await runCli(["run", "impl-review", "--input", "task=x"], deps);
		expect(progress.some((l) => /call builder done in/.test(l))).toBe(true);
		expect(progress.some((l) => /check bun test → ok in/.test(l))).toBe(true);
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

describe("chit apply", () => {
	test("a dry run stores a patch that `chit apply` re-plays exactly (same base)", async () => {
		let appliedPatch: string | undefined;
		let appliedBase: string | undefined;
		const { deps, out } = harness({
			sandboxDiff: "PATCH-BODY",
			onApplyPatch: (patch, base) => {
				appliedPatch = patch;
				appliedBase = base;
			},
		});
		expect(await runCli(["run", "impl-review", "--input", "task=x"], deps)).toBe(0); // dry run stores the patch
		expect(await runCli(["apply", "run-test"], deps)).toBe(0);
		expect(out.join("\n")).toContain("applied run run-test");
		expect(appliedPatch).toBe("PATCH-BODY"); // exactly the reviewed diff, not a re-roll
		expect(appliedBase).toBe("base0000"); // applied onto the recorded base
		expect((loadReceipt(deps.cwd, "run-test") as ConvergeReceipt).appliedAt).toBeDefined(); // durable "applied" marker recorded
	});

	test("refuses an unknown run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["apply", "ghost"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/no run "ghost" found/);
	});

	test("has nothing to apply for a text (non-sandboxed) run", async () => {
		const { deps, err } = harness({ adapter: fakeAdapter(() => "report") });
		await runCli(["run", "feature-griller", "--input", "idea=x"], deps); // a text run: no base, no patch
		expect(await runCli(["apply", "run-test"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/not a sandboxed run/);
	});

	test("surfaces the apply gate's refusal (e.g. HEAD moved off the base)", async () => {
		const { deps, err } = harness({ sandboxDiff: "PATCH", applyError: "this patch was made against abc123 but HEAD is now def456. Re-run the routine on the current tree." });
		await runCli(["run", "impl-review", "--input", "task=x"], deps); // stores a patch
		expect(await runCli(["apply", "run-test"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/HEAD is now def456/);
	});

	test("needs a run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["apply"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/apply needs a run id/);
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

describe("chit run cancellation", () => {
	test("a cancelled run exits 130 and records a cancelled receipt", async () => {
		const controller = new AbortController();
		controller.abort();
		const { deps, err } = harness();
		deps.signal = controller.signal;
		expect(await runCli(["run", "feature-griller", "--input", "idea=x"], deps)).toBe(130);
		expect(err.join("\n")).toMatch(/cancelled/);

		// the receipt persisted with a cancelled status
		const t = harness();
		expect(await runCli(["trace", "run-test"], t.deps)).toBe(0);
		expect(t.out.join("\n")).toContain("run-test  feature-griller  cancelled");
	});
});

describe("chit init", () => {
	const temps: string[] = [];
	afterAll(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});
	function initDeps(cwd: string) {
		const out: string[] = [];
		const err: string[] = [];
		const deps: CliDeps = {
			cwd,
			adapters: { claude: fakeAdapter((req) => `OUT(${req.prompt})`) },
			checkRunner: fakeCheckRunner(),
			sandboxFactory: fakeSandboxFactory(),
			now: () => 0,
			newRunId: () => "run-init",
			out: (l) => out.push(l),
			err: (l) => err.push(l),
		};
		return { deps, out, err };
	}

	test("scaffolds a routine that then lists, resolves, and runs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-init-cli-"));
		temps.push(cwd);
		const { deps, out } = initDeps(cwd);

		expect(await runCli(["init", "myrev"], deps)).toBe(0);
		expect(out.join("\n")).toContain("created chit.config.json#routines.myrev");

		out.length = 0;
		expect(await runCli(["routines"], deps)).toBe(0);
		expect(out.join("\n")).toContain("myrev");

		out.length = 0;
		expect(await runCli(["run", "myrev", "--input", "topic=dark mode"], deps)).toBe(0);
		expect(out.join("\n")).toContain("OUT(");
	});

	test("rejects an invalid template", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "chit-init-cli-"));
		temps.push(cwd);
		const { deps, err } = initDeps(cwd);
		expect(await runCli(["init", "x", "--template", "bogus"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/--template must be one of/);
	});
});

describe("chit doctor", () => {
	test("rejects an unknown option instead of silently running offline", async () => {
		const { deps, err } = harness();
		expect(await runCli(["doctor", "--reel"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/unknown option --reel/);
	});
});

describe("chit help", () => {
	test("prints usage with no args", async () => {
		const { deps, out } = harness();
		expect(await runCli([], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/chit routines/);
	});
});
