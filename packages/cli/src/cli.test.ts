import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { type CheckRunner, fakeCheckRunner } from "./check-runner.ts";
import { type CliDeps, runCli } from "./cli.ts";
import type { ConvergeReceipt } from "./converge.ts";
import { appendRunEvent, readRunEvents } from "./events.ts";
import type { FlowReceipt } from "./flow.ts";
import { listLiveRuns, loadLiveRun, registerLiveRun, unregisterLiveRun } from "./live.ts";
import type { RunReceipt } from "./run.ts";
import { fakeSandboxFactory, gitWorktreeSandboxFactory } from "./sandbox.ts";
import { loadReceipt, prepareRunLog, runArgvPath, runLogPath, saveReceipt } from "./store.ts";

// A background fake child: stand in for the detached process by writing the structured event the
// real child would (the start barrier waits for it). `ready` releases the barrier with success.
function readyingSpawner(
	over: { ready?: boolean } = {},
): CliDeps["backgroundSpawner"] & { spawned: Array<{ args: string[]; cwd: string; env: Record<string, string> }> } {
	const spawned: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = [];
	return {
		spawned,
		spawn(args, opts) {
			spawned.push({ args, cwd: opts.cwd, env: opts.env });
			if (over.ready !== false) appendRunEvent(opts.cwd, opts.env.CHIT_RUN_ID as string, { at: 0, kind: "ready" });
			return { pid: process.pid };
		},
	};
}

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

const ASK_TEXT = {
	id: "ask-text",
	inputs: {},
	agents: {},
	steps: [
		{ id: "name", ask: "Who are you?" },
		{ id: "out", format: "hello {{ steps.name.output }}" },
	],
	output: "out",
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-min-cli-"));
	mkdirSync(join(dir, "examples"), { recursive: true });
	writeFileSync(join(dir, "examples", "feature-griller.json"), JSON.stringify(GRILLER));
	writeFileSync(join(dir, "examples", "impl-review.json"), JSON.stringify(REVIEW));
	writeFileSync(join(dir, "examples", "goal-loop.json"), JSON.stringify(GOAL));
	writeFileSync(join(dir, "examples", "ask-text.json"), JSON.stringify(ASK_TEXT));
	writeFileSync(
		join(dir, "chit.config.json"),
		JSON.stringify({
			routines: {
				"feature-griller": { file: "examples/feature-griller.json", description: "Question a feature idea." },
				"impl-review": { file: "examples/impl-review.json", description: "Implement and review." },
				"goal-loop": { file: "examples/goal-loop.json", description: "Loop until an evaluator says yes." },
				"ask-text": { file: "examples/ask-text.json", description: "Ask then format." },
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
	over: {
		adapter?: Adapter;
		checkRunner?: CheckRunner;
		sandboxDiff?: string;
		applyError?: string;
		onApplyPatch?: (patch: string, base: string) => void;
		runtime?: CliDeps["runtime"];
		backgroundSpawner?: CliDeps["backgroundSpawner"];
		liveProcess?: CliDeps["liveProcess"];
		sleep?: CliDeps["sleep"];
	} = {},
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
		runtime: over.runtime ?? { version: "0.0.0-test", entrypoint: "/tmp/chit-test/src/index.ts" },
		...(over.backgroundSpawner !== undefined && { backgroundSpawner: over.backgroundSpawner }),
		...(over.liveProcess !== undefined && { liveProcess: over.liveProcess }),
		...(over.sleep !== undefined && { sleep: over.sleep }),
	};
	return { deps, out, err };
}

function receipt(runId: string, status: RunReceipt["status"] = "completed"): RunReceipt {
	return {
		runId,
		routineId: "feature-griller",
		policy: "one-shot",
		digest: "digest",
		inputs: { idea: "x" },
		startedAt: 0,
		finishedAt: 1,
		elapsedMs: 1,
		status,
		steps: [],
		...(status === "completed" && { output: "done" }),
		...(status !== "completed" && { error: status === "cancelled" ? "cancelled by operator" : "boom" }),
	};
}

function convergeReceipt(runId: string, over: Partial<ConvergeReceipt> = {}): ConvergeReceipt {
	return {
		runId,
		routineId: "impl-review",
		policy: "converge",
		digest: "digest",
		inputs: { task: "x" },
		maxIterations: 1,
		until: "checks-pass",
		startedAt: 0,
		finishedAt: 1,
		elapsedMs: 1,
		status: "converged",
		iterations: [],
		...over,
	};
}

function flowReceipt(runId: string, status: FlowReceipt["status"] = "completed"): FlowReceipt {
	return {
		runId,
		routineId: "flow",
		policy: "flow",
		digest: "digest",
		inputs: { task: "x" },
		startedAt: 0,
		finishedAt: 1,
		elapsedMs: 1,
		status,
		steps: [],
		...(status !== "completed" && { error: "boom" }),
	};
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

	test("starts a background child once it signals readiness, then returns", async () => {
		const spawner = readyingSpawner();
		const { deps, out } = harness({ backgroundSpawner: spawner });
		deps.newRunId = () => "run-bg";

		try {
			expect(await runCli(["run", "feature-griller", "--input", "idea=x", "--background"], deps)).toBe(0);

			expect(spawner.spawned).toEqual([
				{
					args: [],
					cwd: dir,
					env: {
						CHIT_RUN_ID: "run-bg",
						CHIT_LOG_PATH: runLogPath(dir, "run-bg"),
						CHIT_ARGV_PATH: runArgvPath(dir, "run-bg"),
					},
				},
			]);
			expect(existsSync(runLogPath(dir, "run-bg"))).toBe(true);
			expect(JSON.parse(readFileSync(runArgvPath(dir, "run-bg"), "utf-8"))).toEqual([
				"run",
				"feature-griller",
				"--input",
				"idea=x",
			]);
			expect(loadLiveRun(dir, "run-bg")).toMatchObject({
				runId: "run-bg",
				routineId: "feature-griller",
				pid: process.pid,
			});
			const text = out.join("\n");
			expect(text).toContain("started run-bg in background");
			expect(text).toContain("chit wait run-bg");
			expect(text).toContain("chit ps");
		} finally {
			unregisterLiveRun(dir, "run-bg");
		}
	});

	test("rebuilds background argv from parsed args instead of filtering tokens", async () => {
		const { deps } = harness({ backgroundSpawner: readyingSpawner() });
		deps.newRunId = () => "run-bg-scope";

		try {
			expect(
				await runCli(["run", "feature-griller", "--input", "idea=x", "--scope", "--background", "--background"], deps),
			).toBe(0);

			expect(JSON.parse(readFileSync(runArgvPath(dir, "run-bg-scope"), "utf-8"))).toEqual([
				"run",
				"feature-griller",
				"--input",
				"idea=x",
				"--scope",
				"--background",
			]);
		} finally {
			unregisterLiveRun(dir, "run-bg-scope");
		}
	});

	test("rejects background runs that need human input", async () => {
		let spawned = false;
		const { deps, err } = harness({
			backgroundSpawner: {
				spawn() {
					spawned = true;
					return { pid: process.pid };
				},
			},
		});

		expect(await runCli(["run", "ask-text", "--background"], deps)).toBe(1);

		expect(spawned).toBe(false);
		expect(err.join("\n")).toContain("--background cannot run routines with ask steps");
	});

	test("preflights a sandboxed routine before starting it in the background", async () => {
		let preflighted = false;
		const spawner = readyingSpawner();
		const { deps } = harness({ backgroundSpawner: spawner });
		deps.newRunId = () => "run-bg-sandbox";
		const originalSandboxFactory = deps.sandboxFactory;
		deps.sandboxFactory = {
			...originalSandboxFactory,
			async preflight(cwd) {
				preflighted = true;
				return originalSandboxFactory.preflight(cwd);
			},
		};

		try {
			expect(await runCli(["run", "impl-review", "--input", "task=x", "--background"], deps)).toBe(0);

			expect(preflighted).toBe(true);
			expect(spawner.spawned.length).toBe(1);
		} finally {
			unregisterLiveRun(dir, "run-bg-sandbox");
		}
	});

	test("rejects background auto-apply before spawning", async () => {
		let spawned = false;
		const { deps, err } = harness({
			backgroundSpawner: {
				spawn() {
					spawned = true;
					return { pid: process.pid };
				},
			},
		});

		expect(await runCli(["run", "impl-review", "--input", "task=x", "--background", "--auto-apply"], deps)).toBe(1);

		expect(spawned).toBe(false);
		expect(err.join("\n")).toContain("--background cannot be combined with --auto-apply");
	});

	test("rejects background runs before preflight when the entrypoint cannot spawn children", async () => {
		let preflighted = false;
		const { deps, err } = harness();
		const originalSandboxFactory = deps.sandboxFactory;
		deps.sandboxFactory = {
			...originalSandboxFactory,
			async preflight(cwd) {
				preflighted = true;
				return originalSandboxFactory.preflight(cwd);
			},
		};

		expect(await runCli(["run", "impl-review", "--input", "task=x", "--background"], deps)).toBe(1);

		expect(preflighted).toBe(false);
		expect(err.join("\n")).toContain("this Chit entrypoint cannot start background runs");
	});

	test("blocks until the child signals readiness before reporting the run as started", async () => {
		// The fake child does not signal readiness on spawn; it does so on the first poll, the way a
		// real child reaches readiness only after a beat. The parent must wait for that, not race past.
		let sleeps = 0;
		const { deps, out } = harness({
			backgroundSpawner: readyingSpawner({ ready: false }),
			sleep: async () => {
				sleeps += 1;
				appendRunEvent(dir, "run-bg-wait", { at: 0, kind: "ready", baseCommit: "base0000" });
			},
		});
		deps.newRunId = () => "run-bg-wait";

		try {
			expect(await runCli(["run", "impl-review", "--input", "task=x", "--background"], deps)).toBe(0);
			expect(sleeps).toBe(1);
			expect(out.join("\n")).toContain("started run-bg-wait in background");
		} finally {
			unregisterLiveRun(dir, "run-bg-wait");
		}
	});

	test("surfaces a child's terminal failure event and cleans up the registration", async () => {
		const { deps, err } = harness({
			backgroundSpawner: {
				spawn(_args, opts) {
					appendRunEvent(opts.cwd, opts.env.CHIT_RUN_ID as string, {
						at: 0,
						kind: "failed",
						error: "Sandboxed runs start from HEAD. Commit or stash your changes first.",
					});
					return { pid: process.pid };
				},
			},
		});
		deps.newRunId = () => "run-bg-fail";

		expect(await runCli(["run", "impl-review", "--input", "task=x", "--background"], deps)).toBe(1);

		expect(err.join("\n")).toContain("background run run-bg-fail could not start");
		expect(err.join("\n")).toContain("Commit or stash your changes first");
		expect(loadLiveRun(dir, "run-bg-fail")).toBeUndefined(); // registration dropped
		expect(existsSync(runArgvPath(dir, "run-bg-fail"))).toBe(false); // argv handoff cleaned up
	});

	test("fails when the child dies during startup without signalling readiness", async () => {
		const { deps, err } = harness({
			backgroundSpawner: {
				spawn(_args, opts) {
					// A child that crashes before any event, leaving only its log behind.
					writeFileSync(prepareRunLog(opts.cwd, opts.env.CHIT_RUN_ID as string), "boom: could not load config\n");
					return { pid: process.pid };
				},
			},
			liveProcess: { isAlive: () => false, kill: () => {} },
		});
		deps.newRunId = () => "run-bg-dead";

		expect(await runCli(["run", "impl-review", "--input", "task=x", "--background"], deps)).toBe(1);

		const text = err.join("\n");
		expect(text).toContain("background run run-bg-dead could not start");
		expect(text).toContain("boom: could not load config"); // log tail fallback for a silent death
		expect(loadLiveRun(dir, "run-bg-dead")).toBeUndefined();
	});
});

describe("chit run live progress", () => {
	test("registers the top-level run while it is active and removes it when done", async () => {
		let sawLiveRun = false;
		const { deps } = harness({
			adapter: fakeAdapter(() => {
				sawLiveRun = listLiveRuns(dir).some((r) => r.runId === "run-test" && r.routineId === "feature-griller");
				return "x";
			}),
		});

		expect(await runCli(["run", "feature-griller", "--input", "idea=x"], deps)).toBe(0);

		expect(sawLiveRun).toBe(true);
		expect(loadLiveRun(dir, "run-test")).toBeUndefined();
	});

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

	test("a finished one-shot records a terminal done event carrying its status and exit code", async () => {
		const { deps } = harness({ adapter: fakeAdapter(() => "x") });
		deps.newRunId = () => "run-done-ok";

		expect(await runCli(["run", "feature-griller", "--input", "idea=x"], deps)).toBe(0);

		// The stream is self-contained: a follower sees the run end, not silence after `ready`.
		expect(readRunEvents(dir, "run-done-ok")).toContainEqual({ at: 0, kind: "done", status: "completed", exitCode: 0 });
	});

	test("a loop that never converges records done with its non-zero exit code", async () => {
		const adapter = fakeAdapter((req) => (req.agent === "judge" ? "no" : "draft"));
		const { deps } = harness({ adapter });
		deps.newRunId = () => "run-done-dnc";

		expect(await runCli(["run", "goal-loop", "--input", "goal=ship"], deps)).toBe(1);

		// status and exit code come from the receipt, not a fixed value -- a non-success run proves it.
		expect(readRunEvents(dir, "run-done-dnc")).toContainEqual({
			at: 0,
			kind: "done",
			status: "did-not-converge",
			exitCode: 1,
		});
	});
});

describe("chit ps", () => {
	test("lists live runs for the current repo", async () => {
		registerLiveRun(dir, {
			runId: "run-live",
			routineId: "impl-review",
			pid: process.pid,
			startedAt: -65_000,
			cwd: dir,
		});
		try {
			const { deps, out } = harness();
			deps.now = () => 0;

			expect(await runCli(["ps"], deps)).toBe(0);

			const text = out.join("\n");
			expect(text).toContain("live runs (1):");
			expect(text).toContain("run-live");
			expect(text).toContain("impl-review");
			expect(text).toContain(`pid ${process.pid}`);
			expect(text).toContain("1m ago");
		} finally {
			unregisterLiveRun(dir, "run-live");
		}
	});

	test("rejects unexpected arguments", async () => {
		const { deps, err } = harness();
		expect(await runCli(["ps", "extra"], deps)).toBe(1);
		expect(err.join("\n")).toContain("unexpected argument");
	});
});

describe("chit wait", () => {
	test("prints an existing receipt and exits with its status", async () => {
		saveReceipt(dir, receipt("run-wait-done"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-done"], deps)).toBe(0);

		expect(out.join("\n")).toContain("run-wait-done  feature-griller  completed");
	});

	test("returns a failure code for a failed receipt", async () => {
		saveReceipt(dir, receipt("run-wait-failed", "failed"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-failed"], deps)).toBe(1);

		expect(out.join("\n")).toContain("run-wait-failed  feature-griller  failed");
	});

	test("returns 130 for a cancelled receipt", async () => {
		saveReceipt(dir, receipt("run-wait-cancelled", "cancelled"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-cancelled"], deps)).toBe(130);

		expect(out.join("\n")).toContain("run-wait-cancelled  feature-griller  cancelled");
	});

	test("returns flow receipt exit codes", async () => {
		saveReceipt(dir, flowReceipt("run-wait-flow-ok"));
		saveReceipt(dir, flowReceipt("run-wait-flow-failed", "failed"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-flow-ok"], deps)).toBe(0);
		expect(await runCli(["wait", "run-wait-flow-failed"], deps)).toBe(1);

		const text = out.join("\n");
		expect(text).toContain("run-wait-flow-ok  flow  completed");
		expect(text).toContain("run-wait-flow-failed  flow  failed");
	});

	test("blocks on a live run until its receipt appears", async () => {
		registerLiveRun(dir, {
			runId: "run-wait-live",
			routineId: "feature-griller",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		let sleeps = 0;
		try {
			const { deps, out } = harness({
				liveProcess: { isAlive: () => true, kill: () => {} },
				sleep: async () => {
					sleeps += 1;
					saveReceipt(dir, receipt("run-wait-live"));
				},
			});

			expect(await runCli(["wait", "run-wait-live"], deps)).toBe(0);

			expect(sleeps).toBe(1);
			expect(out.join("\n")).toContain("run-wait-live  feature-griller  completed");
		} finally {
			unregisterLiveRun(dir, "run-wait-live");
		}
	});

	test("streams the run's events and a heartbeat while it is live, then prints the receipt", async () => {
		registerLiveRun(dir, { runId: "run-wait-progress", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		const progress: string[] = [];
		let clock = 0;
		let step = 0;
		try {
			const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
			deps.now = () => clock;
			deps.onProgress = (l) => progress.push(l);
			deps.sleep = async () => {
				step += 1;
				if (step === 1) {
					// The child accepts its base and begins working.
					appendRunEvent(dir, "run-wait-progress", { at: 0, kind: "ready", baseCommit: "base0000" });
					appendRunEvent(dir, "run-wait-progress", { at: 0, kind: "progress", line: "iteration 1" });
				} else if (step === 2) {
					clock += 20_000; // 20s of quiet -> the next poll should heartbeat
				} else {
					saveReceipt(dir, convergeReceipt("run-wait-progress"));
				}
			};

			expect(await runCli(["wait", "run-wait-progress"], deps)).toBe(0);

			const streamed = progress.join("\n");
			expect(streamed).toContain("base base0000 pinned"); // the readiness phase
			expect(streamed).toContain("iteration 1"); // a progress change
			expect(streamed).toContain("still waiting on run-wait-progress"); // the heartbeat
			expect(out.join("\n")).toContain("run-wait-progress  impl-review  converged");
		} finally {
			unregisterLiveRun(dir, "run-wait-progress");
		}
	});

	test("fails when a live run disappears without a receipt", async () => {
		registerLiveRun(dir, {
			runId: "run-wait-dead",
			routineId: "feature-griller",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		const { deps, err } = harness({
			liveProcess: { isAlive: () => false, kill: () => {} },
		});

		expect(await runCli(["wait", "run-wait-dead"], deps)).toBe(1);

		expect(err.join("\n")).toContain("no receipt was written");
		expect(loadLiveRun(dir, "run-wait-dead")).toBeUndefined();
	});

	test("prints an existing receipt even if no live entry remains", async () => {
		saveReceipt(dir, receipt("run-wait-race-missing"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-race-missing"], deps)).toBe(0);

		expect(out.join("\n")).toContain("run-wait-race-missing  feature-griller  completed");
	});

	test("returns a receipt if the process died after the first receipt read", async () => {
		registerLiveRun(dir, {
			runId: "run-wait-race-dead",
			routineId: "feature-griller",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		const { deps, out } = harness({
			liveProcess: {
				isAlive: () => {
					saveReceipt(dir, receipt("run-wait-race-dead"));
					return false;
				},
				kill: () => {},
			},
		});

		expect(await runCli(["wait", "run-wait-race-dead"], deps)).toBe(0);

		expect(out.join("\n")).toContain("run-wait-race-dead  feature-griller  completed");
	});

	test("returns failure for a converged receipt with an apply error", async () => {
		saveReceipt(dir, convergeReceipt("run-wait-apply-error", { applyError: "could not apply" }));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wait-apply-error"], deps)).toBe(1);

		expect(out.join("\n")).toContain("run-wait-apply-error  impl-review  converged");
	});

	test("prints the background log when no receipt was written", async () => {
		registerLiveRun(dir, {
			runId: "run-wait-log",
			routineId: "feature-griller",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		writeFileSync(prepareRunLog(dir, "run-wait-log"), "child failed before receipt\n", "utf-8");
		const { deps, err } = harness({
			liveProcess: { isAlive: () => false, kill: () => {} },
		});

		expect(await runCli(["wait", "run-wait-log"], deps)).toBe(1);

		expect(err.join("\n")).toContain("last output from run-wait-log");
		expect(err.join("\n")).toContain("child failed before receipt");
	});

	test("rejects missing and extra arguments", async () => {
		const { deps, err } = harness();

		expect(await runCli(["wait"], deps)).toBe(1);
		expect(await runCli(["wait", "a", "b"], deps)).toBe(1);

		expect(err.join("\n")).toContain("wait needs a run id");
		expect(err.join("\n")).toContain("unexpected argument");
	});
});

describe("chit status", () => {
	test("renders a finished run's state (human) and points at trace", async () => {
		saveReceipt(dir, convergeReceipt("run-status-fin", { status: "did-not-converge" }));
		const { deps, out } = harness();
		expect(await runCli(["status", "run-status-fin"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run-status-fin  impl-review  finished: did-not-converge");
		expect(text).toContain("chit trace run-status-fin");
	});

	test("--json emits the canonical state object", async () => {
		saveReceipt(dir, receipt("run-status-json", "completed"));
		const { deps, out } = harness();
		expect(await runCli(["status", "run-status-json", "--json"], deps)).toBe(0);
		expect(out.length).toBe(1); // stdout is exactly one JSON object
		expect(JSON.parse(out.join("\n"))).toMatchObject({
			runId: "run-status-json",
			routineId: "feature-griller",
			phase: "finished",
			done: true,
			status: "completed",
			exitCode: 0,
		});
	});

	test("reports a live run as running once it has signalled ready", async () => {
		registerLiveRun(dir, { runId: "run-status-live", routineId: "impl-review", pid: 4242, startedAt: 0, cwd: dir });
		appendRunEvent(dir, "run-status-live", { at: 0, kind: "ready", baseCommit: "abc123def456" });
		try {
			const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
			deps.now = () => 5000;
			expect(await runCli(["status", "run-status-live", "--json"], deps)).toBe(0);
			const state = JSON.parse(out.join("\n"));
			expect(state).toMatchObject({ phase: "running", done: false, pid: 4242 });
			expect(state.status).toBeUndefined(); // no receipt yet -> no terminal status
		} finally {
			unregisterLiveRun(dir, "run-status-live");
		}
	});

	test("exits 1 for an unknown run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["status", "run-nope"], deps)).toBe(1);
		expect(err.join("\n")).toContain('no run "run-nope" found');
	});

	test("needs a run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["status"], deps)).toBe(1);
		expect(err.join("\n")).toContain("status needs a run id");
	});
});

describe("chit ps --json", () => {
	test("emits an array of live-run states from the shared read model", async () => {
		registerLiveRun(dir, { runId: "run-ps-json", routineId: "impl-review", pid: process.pid, startedAt: 0, cwd: dir });
		appendRunEvent(dir, "run-ps-json", { at: 0, kind: "ready" });
		try {
			const { deps, out } = harness();
			deps.now = () => 0;
			expect(await runCli(["ps", "--json"], deps)).toBe(0);
			const states = JSON.parse(out.join("\n"));
			expect(Array.isArray(states)).toBe(true);
			expect(states.find((s: { runId: string }) => s.runId === "run-ps-json")).toMatchObject({
				routineId: "impl-review",
				phase: "running",
				done: false,
				pid: process.pid,
			});
		} finally {
			unregisterLiveRun(dir, "run-ps-json");
		}
	});

	test("uses finished receipt state when a live entry lingers", async () => {
		saveReceipt(dir, receipt("run-ps-json-finished", "completed"));
		registerLiveRun(dir, {
			runId: "run-ps-json-finished",
			routineId: "impl-review",
			pid: process.pid,
			startedAt: 0,
			cwd: dir,
		});
		try {
			const { deps, out } = harness();
			expect(await runCli(["ps", "--json"], deps)).toBe(0);
			const states = JSON.parse(out.join("\n"));
			expect(states.find((s: { runId: string }) => s.runId === "run-ps-json-finished")).toMatchObject({
				routineId: "feature-griller",
				phase: "finished",
				done: true,
				status: "completed",
				exitCode: 0,
			});
		} finally {
			unregisterLiveRun(dir, "run-ps-json-finished");
		}
	});
});

describe("chit wait --json", () => {
	test("prints one final state object and preserves the exit code", async () => {
		saveReceipt(dir, convergeReceipt("run-wjson-ok", { status: "converged" }));
		saveReceipt(dir, receipt("run-wjson-fail", "failed"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-wjson-ok", "--json"], deps)).toBe(0);
		expect(JSON.parse(out.join("\n"))).toMatchObject({
			phase: "finished",
			status: "converged",
			exitCode: 0,
			done: true,
		});

		out.length = 0;
		expect(await runCli(["wait", "run-wjson-fail", "--json"], deps)).toBe(1);
		expect(JSON.parse(out.join("\n"))).toMatchObject({ phase: "finished", status: "failed", exitCode: 1 });
	});

	test("emits an orphaned state object on stdout (exit 1) when a run ends with no receipt", async () => {
		registerLiveRun(dir, { runId: "run-wjson-orphan", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		writeFileSync(prepareRunLog(dir, "run-wjson-orphan"), "boom\n", "utf-8");
		const { deps, out, err } = harness({ liveProcess: { isAlive: () => false, kill: () => {} } });

		expect(await runCli(["wait", "run-wjson-orphan", "--json"], deps)).toBe(1);

		expect(out.length).toBe(1); // stdout is ONLY the JSON object
		expect(JSON.parse(out.join("\n"))).toMatchObject({
			runId: "run-wjson-orphan",
			routineId: "impl-review",
			phase: "orphaned",
			done: true,
			exitCode: 1,
		});
		expect(err.join("\n")).toContain("no longer running"); // diagnostics stay on stderr
	});

	test("streams progress to stderr only, keeping stdout pure JSON", async () => {
		registerLiveRun(dir, { runId: "run-wjson-stream", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		const progress: string[] = [];
		let step = 0;
		const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
		deps.onProgress = (l) => progress.push(l);
		deps.sleep = async () => {
			step += 1;
			if (step === 1) appendRunEvent(dir, "run-wjson-stream", { at: 0, kind: "progress", line: "iteration 1" });
			else saveReceipt(dir, convergeReceipt("run-wjson-stream"));
		};

		expect(await runCli(["wait", "run-wjson-stream", "--json"], deps)).toBe(0);

		expect(progress.join("\n")).toContain("iteration 1"); // progress went to stderr (onProgress)
		expect(out.length).toBe(1); // stdout is exactly one JSON object
		expect(() => JSON.parse(out.join("\n"))).not.toThrow();
	});
});

describe("chit wait --follow", () => {
	test("streams lifecycle events as JSONL on stdout, then a final run-state object", async () => {
		registerLiveRun(dir, { runId: "run-follow", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		let step = 0;
		const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
		deps.sleep = async () => {
			step += 1;
			if (step === 1) {
				appendRunEvent(dir, "run-follow", { at: 0, kind: "ready", baseCommit: "base0000" });
				appendRunEvent(dir, "run-follow", { at: 0, kind: "progress", line: "iteration 1" });
			} else {
				// A real run writes its receipt, then its terminal done event.
				saveReceipt(dir, convergeReceipt("run-follow"));
				appendRunEvent(dir, "run-follow", { at: 0, kind: "done", status: "converged", exitCode: 0 });
			}
		};

		try {
			expect(await runCli(["wait", "run-follow", "--follow", "--json"], deps)).toBe(0);
		} finally {
			unregisterLiveRun(dir, "run-follow");
		}

		// Every stdout line is one JSON value: the run's events as they arrived, then the run-state last.
		const lines = out.map((l) => JSON.parse(l));
		expect(lines).toContainEqual({ at: 0, kind: "ready", baseCommit: "base0000" });
		expect(lines).toContainEqual({ at: 0, kind: "progress", line: "iteration 1" });
		expect(lines).toContainEqual({ at: 0, kind: "done", status: "converged", exitCode: 0 });
		const last = lines.at(-1);
		expect(last).toMatchObject({
			runId: "run-follow",
			phase: "finished",
			status: "converged",
			exitCode: 0,
			done: true,
		});
		expect(last.kind).toBeUndefined(); // the final line is a run-state, not an event
	});

	test("does not emit the final state before done when a receipt appears first", async () => {
		registerLiveRun(dir, {
			runId: "run-follow-receipt-first",
			routineId: "impl-review",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		let step = 0;
		const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
		deps.sleep = async () => {
			step += 1;
			if (step === 1) {
				saveReceipt(dir, convergeReceipt("run-follow-receipt-first"));
			} else {
				appendRunEvent(dir, "run-follow-receipt-first", {
					at: 0,
					kind: "done",
					status: "converged",
					exitCode: 0,
				});
			}
		};

		try {
			expect(await runCli(["wait", "run-follow-receipt-first", "--follow", "--json"], deps)).toBe(0);
		} finally {
			unregisterLiveRun(dir, "run-follow-receipt-first");
		}

		expect(step).toBe(2);
		const lines = out.map((l) => JSON.parse(l));
		const doneIndex = lines.findIndex((line) => line.kind === "done");
		const finalIndex = lines.findIndex(
			(line) => line.runId === "run-follow-receipt-first" && line.phase === "finished",
		);
		expect(doneIndex).toBeGreaterThanOrEqual(0);
		expect(finalIndex).toBeGreaterThan(doneIndex);
	});

	test("synthesizes done before the final state for legacy receipts with no done event", async () => {
		saveReceipt(dir, convergeReceipt("run-follow-legacy"));
		const { deps, out } = harness();

		expect(await runCli(["wait", "run-follow-legacy", "--follow", "--json"], deps)).toBe(0);

		const lines = out.map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ kind: "done", status: "converged", exitCode: 0 });
		expect(lines[1]).toMatchObject({ runId: "run-follow-legacy", phase: "finished", done: true });
	});

	test("emits a final orphaned run-state line when a followed run dies with no receipt", async () => {
		registerLiveRun(dir, { runId: "run-follow-orphan", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		writeFileSync(prepareRunLog(dir, "run-follow-orphan"), "boom\n", "utf-8");
		const { deps, out, err } = harness({ liveProcess: { isAlive: () => false, kill: () => {} } });

		expect(await runCli(["wait", "run-follow-orphan", "--follow", "--json"], deps)).toBe(1);

		// stdout stays pure JSONL: the only line is the final orphaned run-state object.
		const lines = out.map((l) => JSON.parse(l));
		expect(lines.at(-1)).toMatchObject({ runId: "run-follow-orphan", phase: "orphaned", done: true, exitCode: 1 });
		expect(err.join("\n")).toContain("no longer running"); // diagnostics stay on stderr
	});

	test("drains pending events before the final orphaned state", async () => {
		registerLiveRun(dir, {
			runId: "run-follow-orphan-drain",
			routineId: "impl-review",
			pid: 1234,
			startedAt: 0,
			cwd: dir,
		});
		appendRunEvent(dir, "run-follow-orphan-drain", { at: 0, kind: "progress", line: "iteration 1" });
		appendRunEvent(dir, "run-follow-orphan-drain", { at: 0, kind: "failed", error: "child crashed" });
		const { deps, out } = harness({ liveProcess: { isAlive: () => false, kill: () => {} } });

		expect(await runCli(["wait", "run-follow-orphan-drain", "--follow", "--json"], deps)).toBe(1);

		const lines = out.map((l) => JSON.parse(l));
		expect(lines[0]).toEqual({ at: 0, kind: "progress", line: "iteration 1" });
		expect(lines[1]).toEqual({ at: 0, kind: "failed", error: "child crashed" });
		expect(lines[2]).toMatchObject({ runId: "run-follow-orphan-drain", phase: "orphaned", done: true });
	});

	test("Ctrl-C detaches the follower without stopping the live run", async () => {
		registerLiveRun(dir, { runId: "run-follow-detach", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		appendRunEvent(dir, "run-follow-detach", { at: 0, kind: "ready", baseCommit: "base0000" });
		const controller = new AbortController();
		controller.abort();
		const { deps, out, err } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
		deps.signal = controller.signal;

		try {
			expect(await runCli(["wait", "run-follow-detach", "--follow", "--json"], deps)).toBe(130);
			expect(loadLiveRun(dir, "run-follow-detach")).toBeDefined();
		} finally {
			unregisterLiveRun(dir, "run-follow-detach");
		}

		const lines = out.map((l) => JSON.parse(l));
		expect(lines).toContainEqual({ at: 0, kind: "ready", baseCommit: "base0000" });
		expect(lines).toContainEqual({
			at: 0,
			kind: "detached",
			runId: "run-follow-detach",
			message: "detached from wait; the run is still active",
			nextCommand: "chit stop run-follow-detach",
		});
		expect(lines.at(-1)).toMatchObject({
			runId: "run-follow-detach",
			phase: "running",
			done: false,
			pid: 1234,
		});
		expect(err.join("\n")).toContain("detached from wait");
		expect(err.join("\n")).toContain("chit stop run-follow-detach");
	});

	test("rejects --follow without --json", async () => {
		const { deps, err } = harness();

		expect(await runCli(["wait", "run-x", "--follow"], deps)).toBe(1);

		expect(err.join("\n")).toContain("requires --json");
	});
});

describe("chit --project (project addressing)", () => {
	const extra: string[] = [];
	afterAll(() => {
		for (const d of extra) rmSync(d, { recursive: true, force: true });
	});
	function freshDir(prefix: string): string {
		const p = mkdtempSync(join(tmpdir(), prefix));
		extra.push(p);
		return p;
	}

	test("--project redirects a command to another project dir", async () => {
		const proj = freshDir("chit-proj-");
		saveReceipt(proj, receipt("run-elsewhere", "completed"));
		const { deps, out } = harness();
		deps.cwd = freshDir("chit-cwd-"); // a cwd with no such run

		expect(await runCli(["status", "run-elsewhere"], deps)).toBe(1); // not in cwd
		expect(await runCli(["status", "run-elsewhere", "--project", proj], deps)).toBe(0); // found via --project
		expect(out.join("\n")).toContain("run-elsewhere");
	});

	test("CHIT_PROJECT is the fallback, and --project overrides it", async () => {
		const projEnv = freshDir("chit-projenv-");
		const projArg = freshDir("chit-projarg-");
		saveReceipt(projEnv, receipt("run-env", "completed"));
		saveReceipt(projArg, receipt("run-arg", "completed"));
		const { deps } = harness();
		deps.cwd = freshDir("chit-cwd-");
		deps.projectEnv = projEnv;

		expect(await runCli(["status", "run-env"], deps)).toBe(0); // falls back to CHIT_PROJECT
		expect(await runCli(["status", "run-arg", "--project", projArg], deps)).toBe(0); // arg wins
		expect(await runCli(["status", "run-env", "--project", projArg], deps)).toBe(1); // arg dir lacks run-env
	});

	test("the --project=<path> form is accepted", async () => {
		const proj = freshDir("chit-projeq-");
		saveReceipt(proj, receipt("run-eqform", "completed"));
		const { deps } = harness();
		deps.cwd = freshDir("chit-cwd-");
		expect(await runCli([`--project=${proj}`, "status", "run-eqform"], deps)).toBe(0);
	});

	test("a missing project path fails clearly", async () => {
		const { deps, err } = harness();
		expect(await runCli(["status", "x", "--project", "/no/such/chit/dir"], deps)).toBe(1);
		expect(err.join("\n")).toContain("project path not found");
	});

	test("--project with no value is rejected", async () => {
		const { deps, err } = harness();
		expect(await runCli(["ps", "--project"], deps)).toBe(1);
		expect(err.join("\n")).toContain("--project expects a path");
	});
});

describe("chit stop", () => {
	test("sends SIGTERM to a live run pid", async () => {
		const child = Bun.spawn(["sleep", "5"]);
		registerLiveRun(dir, {
			runId: "run-stop",
			routineId: "impl-review",
			pid: child.pid,
			startedAt: 0,
			cwd: dir,
		});
		try {
			const { deps, out } = harness();

			expect(await runCli(["stop", "run-stop"], deps)).toBe(0);
			expect(out.join("\n")).toContain(`sent SIGTERM to run-stop (pid ${child.pid})`);
			expect(await child.exited).not.toBe(0);
		} finally {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {}
			unregisterLiveRun(dir, "run-stop");
		}
	});

	test("reports a missing live run", async () => {
		const { deps, err } = harness();
		expect(await runCli(["stop", "missing"], deps)).toBe(1);
		expect(err.join("\n")).toContain('no live run "missing" found');
	});

	test("supports --force", async () => {
		const child = Bun.spawn(["sleep", "5"]);
		registerLiveRun(dir, {
			runId: "run-kill",
			routineId: "impl-review",
			pid: child.pid,
			startedAt: 0,
			cwd: dir,
		});
		try {
			const { deps, out } = harness();

			expect(await runCli(["stop", "run-kill", "--force"], deps)).toBe(0);
			expect(out.join("\n")).toContain(`sent SIGKILL to run-kill (pid ${child.pid})`);
			expect(await child.exited).not.toBe(0);
		} finally {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {}
			unregisterLiveRun(dir, "run-kill");
		}
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

	test("points at live-run surfaces when the run has no receipt yet", async () => {
		registerLiveRun(dir, { runId: "run-trace-live", routineId: "impl-review", pid: 1234, startedAt: 0, cwd: dir });
		appendRunEvent(dir, "run-trace-live", { at: 0, kind: "ready" });
		const { deps, out } = harness({ liveProcess: { isAlive: () => true, kill: () => {} } });
		deps.now = () => 2000;

		try {
			expect(await runCli(["trace", "run-trace-live"], deps)).toBe(0);
		} finally {
			unregisterLiveRun(dir, "run-trace-live");
		}

		const text = out.join("\n");
		expect(text).toContain("run run-trace-live is still running");
		expect(text).toContain("routine: impl-review");
		expect(text).toContain("status:  chit status run-trace-live");
		expect(text).toContain("wait:    chit wait run-trace-live");
	});

	test("refuses an unknown run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["trace", "nope"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/no run "nope" found/);
	});
});

describe("chit result", () => {
	test("emits the compact machine contract for a finished converge run", async () => {
		// Run a real sandboxed loop (checks-pass) through the CLI so the receipt is genuine.
		await runCli(["run", "impl-review", "--input", "task=x"], harness().deps);

		const { deps, out } = harness();
		expect(await runCli(["result", "run-test", "--json"], deps)).toBe(0);
		expect(out.length).toBe(1); // stdout is exactly one JSON object
		const result = JSON.parse(out.join("\n"));
		expect(result).toMatchObject({
			runId: "run-test",
			routineId: "impl-review",
			phase: "finished",
			done: true,
			status: "converged",
			exitCode: 0,
			until: "checks-pass",
			signals: [{ kind: "checks-pass", passed: true }],
			checks: [{ stepId: "verify", command: "bun test", ok: true }],
			structuredSteps: {},
		});
		// A converged run stored a patch; the path is project-relative and apply readiness is a boolean.
		expect(result.patchPath).toBe(".chit/runs/run-test.patch");
		expect(typeof result.applyReady).toBe("boolean");
		expect(result.debugPatchPath).toBeNull();
	});

	test("works without --json too (result is the machine contract)", async () => {
		await runCli(["run", "impl-review", "--input", "task=x"], harness().deps);
		const { deps, out } = harness();
		expect(await runCli(["result", "run-test"], deps)).toBe(0);
		expect(JSON.parse(out.join("\n"))).toMatchObject({ runId: "run-test", phase: "finished" });
	});

	test("errors for a run with no receipt yet and points at the live surfaces", async () => {
		const { deps, err } = harness();
		expect(await runCli(["result", "run-ghost", "--json"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/no finished run "run-ghost" found .*chit status \/ chit wait/);
	});

	test("needs a run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["result"], deps)).toBe(1);
		expect(err.join("\n")).toContain("result needs a run id");
	});

	test("rejects an unknown option", async () => {
		const { deps, err } = harness();
		expect(await runCli(["result", "run-test", "--full"], deps)).toBe(1);
		expect(err.join("\n")).toContain("unknown option --full");
	});

	test("`chit result --help` prints focused help", async () => {
		const { deps, out } = harness();
		expect(await runCli(["result", "--help"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("chit result <run-id> [--json]");
		expect(text).toContain("repeat.until");
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
		const { deps, err } = harness({
			sandboxDiff: "PATCH",
			applyError: "this patch was made against abc123 but HEAD is now def456. Re-run the routine on the current tree.",
		});
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
		const { baseCommit } = await gitWorktreeSandboxFactory.preflight(repo);
		const sb = await gitWorktreeSandboxFactory.create(repo, "leak", baseCommit);
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
		expect(readRunEvents(dir, "run-test")).toContainEqual({ at: 0, kind: "done", status: "cancelled", exitCode: 130 });
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

	test("shows the running Chit version and entrypoint", async () => {
		const { deps, out } = harness();
		deps.doctorProbes = {
			commandExists: async () => true,
			gitState: async () => ({ isRepo: true, clean: true }),
		};
		expect(await runCli(["doctor"], deps)).toBe(0);
		expect(out.join("\n")).toContain("version 0.0.0-test, entrypoint /tmp/chit-test/src/index.ts");
	});
});

describe("chit help", () => {
	test("prints usage with no args", async () => {
		const { deps, out } = harness();
		expect(await runCli([], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/chit routines/);
	});

	test("`chit help <command>` prints focused help for that command", async () => {
		const { deps, out } = harness();
		expect(await runCli(["help", "run"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("chit run <routine> [options]");
		expect(text).toContain("--background");
		expect(text).not.toMatch(/chit routines {2}list/); // focused, not the full usage
	});

	test("`chit <command> --help` and `-h` print that command's help and exit 0", async () => {
		for (const flag of ["--help", "-h"]) {
			const { deps, out } = harness();
			expect(await runCli(["wait", flag], deps)).toBe(0);
			expect(out.join("\n")).toContain("chit wait <run-id>");
			expect(out.join("\n")).toContain("heartbeat");
		}
	});

	test("focused help includes global project addressing", async () => {
		const { deps, out } = harness();
		expect(await runCli(["status", "--help"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("--project <path>");
		expect(text).toContain("CHIT_PROJECT");
	});

	test("`chit help <unknown>` falls back to full usage rather than erroring", async () => {
		const { deps, out } = harness();
		expect(await runCli(["help", "bogus"], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/chit routines/);
	});

	test("a help request short-circuits before argument validation", async () => {
		// `chit run --help` must print help, not complain that a routine id is missing.
		const { deps, out, err } = harness();
		expect(await runCli(["run", "--help"], deps)).toBe(0);
		expect(out.join("\n")).toContain("chit run <routine>");
		expect(err.join("\n")).toBe("");
	});

	test("help ignores a stale CHIT_PROJECT", async () => {
		for (const argv of [["--help"], ["help", "run"], ["run", "--help"]]) {
			const { deps, out, err } = harness();
			deps.projectEnv = "/no/such/chit/project";
			expect(await runCli(argv, deps)).toBe(0);
			expect(out.join("\n")).toContain("chit");
			expect(err.join("\n")).toBe("");
		}
	});
});

describe("chit version", () => {
	test("prints the version, with optional entrypoint detail", async () => {
		const { deps, out } = harness();
		expect(await runCli(["--version"], deps)).toBe(0);
		expect(out).toEqual(["chit 0.0.0-test"]);

		out.length = 0;
		expect(await runCli(["--version", "--verbose"], deps)).toBe(0);
		expect(out).toEqual(["chit 0.0.0-test", "entrypoint /tmp/chit-test/src/index.ts"]);
	});

	test("version ignores a stale CHIT_PROJECT", async () => {
		const { deps, out, err } = harness();
		deps.projectEnv = "/no/such/chit/project";
		expect(await runCli(["--version"], deps)).toBe(0);
		expect(out).toEqual(["chit 0.0.0-test"]);
		expect(err.join("\n")).toBe("");
	});
});
