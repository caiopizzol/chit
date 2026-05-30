import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLoop } from "../loops/log-store.ts";
import { type ConvergeExecute, type ConvergeIO, convergeLoop, runConverge } from "./converge.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-converge-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

// A review string carrying the structured fenced JSON block the driver parses.
// The driver reads ONLY this block (prose verdicts are ignored / fail safe to
// block), so tests drive the loop through it.
function reviewJson(
	verdict: string,
	extra: { findingCount?: number; checksRun?: string } = {},
): string {
	const block = {
		verdict,
		findingCount: extra.findingCount ?? 0,
		checksRun: extra.checksRun ?? "none",
		risk: "none",
	};
	return `Reviewed the diff.\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``;
}

// A fake execute that replays a queued list of review texts, recording the
// inputs it was called with. No real agents — the loop runs against canned
// manifest outputs.
function fakeExecute(reviews: string[]): {
	execute: ConvergeExecute;
	calls: { task: string; prior_review: string }[];
} {
	const calls: { task: string; prior_review: string }[] = [];
	let i = 0;
	const execute: ConvergeExecute = async (inputs) => {
		calls.push(inputs);
		const review = reviews[i++] ?? "";
		return {
			ok: true,
			output: "",
			outputs: { implement: `impl summary ${i}`, review },
			trace: [],
		};
	};
	return { execute, calls };
}

function verdicts(loopId: string): string[] {
	return readLoop(cwd, loopId)
		.filter((r) => r.type === "iteration")
		.map((r) => (r.type === "iteration" ? r.verdict : ""));
}

function stopStatus(loopId: string): string | undefined {
	const stop = readLoop(cwd, loopId).find((r) => r.type === "stop");
	return stop?.type === "stop" ? stop.status : undefined;
}

function firstIteration(loopId: string) {
	const it = readLoop(cwd, loopId).find((r) => r.type === "iteration");
	if (it?.type !== "iteration") throw new Error(`no iteration record for ${loopId}`);
	return it;
}

function stopRecord(loopId: string) {
	const s = readLoop(cwd, loopId).find((r) => r.type === "stop");
	return s?.type === "stop" ? s : undefined;
}

// Restore env vars the CLI tests mutate (PATH / XDG_*), deleting any that were
// unset to begin with so state does not leak between tests.
function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("convergeLoop", () => {
	test("revise then proceed converges in 2 iterations", async () => {
		const firstReview = reviewJson("revise");
		const { execute, calls } = fakeExecute([firstReview, reviewJson("proceed")]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "do the thing",
			maxIterations: 3,
			loopId: "L1",
			execute,
		});
		expect(res.iterations).toBe(2);
		expect(res.status).toBe("converged");
		expect(verdicts("L1")).toEqual(["revise", "proceed"]);
		expect(stopStatus("L1")).toBe("converged");
		// The first review is fed back as prior_review on the second iteration.
		expect(calls[0]?.prior_review).toBe("");
		expect(calls[1]?.prior_review).toBe(firstReview);
	});

	test("immediate proceed converges in 1 iteration", async () => {
		const { execute } = fakeExecute([reviewJson("proceed")]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "L2",
			execute,
		});
		expect(res.iterations).toBe(1);
		expect(res.status).toBe("converged");
		expect(stopStatus("L2")).toBe("converged");
	});

	test("block stops the loop as blocked", async () => {
		const { execute } = fakeExecute([reviewJson("block")]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "L3",
			execute,
		});
		expect(res.iterations).toBe(1);
		expect(res.status).toBe("blocked");
		expect(verdicts("L3")).toEqual(["block"]);
		expect(stopStatus("L3")).toBe("blocked");
	});

	test("exhausting the iteration budget stops as max-iterations", async () => {
		const { execute } = fakeExecute([
			reviewJson("revise"),
			reviewJson("revise"),
			reviewJson("revise"),
		]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "L4",
			execute,
		});
		expect(res.iterations).toBe(3);
		expect(res.status).toBe("max-iterations");
		expect(verdicts("L4")).toEqual(["revise", "revise", "revise"]);
		expect(stopStatus("L4")).toBe("max-iterations");
	});

	test("an unparseable verdict is treated as block (never proceed)", async () => {
		const { execute } = fakeExecute(["the reviewer rambled with no verdict line"]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "L5",
			execute,
		});
		expect(res.iterations).toBe(1);
		expect(res.status).toBe("blocked");
		expect(verdicts("L5")).toEqual(["block"]);
		expect(stopStatus("L5")).toBe("blocked");
	});

	test("reads verdict/findingCount/checksRun from the fenced JSON block (ignoring prose)", async () => {
		// Prose says revise; the structured block says proceed. The driver follows
		// the structured block — the only source of truth for the verdict.
		const review = [
			"Findings below.",
			"Verdict: revise",
			"```json",
			JSON.stringify({
				verdict: "proceed",
				findingCount: 2,
				checksRun: "bun test; tsc",
				risk: "low",
			}),
			"```",
		].join("\n");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "did it", review },
			trace: [{ type: "step.completed", stepId: "review", output: review, durationMs: 4200 }],
		});
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "S1",
			execute,
		});
		expect(res.status).toBe("converged");
		const it = firstIteration("S1");
		expect(it.verdict).toBe("proceed");
		expect(it.findingCount).toBe(2);
		expect(it.checksRun).toBe("bun test; tsc");
		// checkDurationMs is the review step's own trace duration, not wall time.
		expect(it.checkDurationMs).toBe(4200);
	});

	test("records token usage summed across implement and review steps", async () => {
		const review = reviewJson("proceed");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "did it", review },
			trace: [
				{
					type: "step.completed",
					stepId: "implement",
					output: "x",
					durationMs: 100,
					// Claude-style: tokens + a reported cost.
					usage: {
						inputTokens: 6590,
						outputTokens: 40,
						cachedInputTokens: 17308,
						estimatedCostUsd: 0.066,
					},
				},
				{
					type: "step.completed",
					stepId: "review",
					output: review,
					durationMs: 4200,
					// Codex-style: tokens incl. reasoning, no cost.
					usage: {
						inputTokens: 15642,
						cachedInputTokens: 4480,
						outputTokens: 26,
						reasoningTokens: 19,
					},
				},
			],
		});
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "U1", execute });
		const it = firstIteration("U1");
		// Per-field sums: input 6590+15642, output 40+26, cached 17308+4480; reasoning
		// only review (19); cost only implement (0.066) since review reports none.
		expect(it.usage).toEqual({
			inputTokens: 22232,
			outputTokens: 66,
			cachedInputTokens: 21788,
			reasoningTokens: 19,
			estimatedCostUsd: 0.066,
		});
	});

	test("usage is absent in the record when no step reported usage", async () => {
		const { execute } = fakeExecute([reviewJson("proceed")]); // fakeExecute trace is []
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "U2", execute });
		expect("usage" in firstIteration("U2")).toBe(false);
	});

	test("resolves to block when the JSON block is absent, even if prose says proceed", async () => {
		// The reviewer echoes the option list ("proceed / revise / block") but emits
		// no JSON block. The driver must fail safe to block, never read proceed.
		const { execute } = fakeExecute(["Verdict: proceed / revise / block — pick one.\nLooks fine."]);
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "S2", execute });
		const it = firstIteration("S2");
		expect(it.verdict).toBe("block");
		expect(it.findingCount).toBe(0);
		expect(it.checksRun).toBe("unreported");
		// fakeExecute supplies no trace, so the check duration is 0.
		expect(it.checkDurationMs).toBe(0);
		expect(stopStatus("S2")).toBe("blocked");
	});

	test("resolves to block when the JSON block is present but malformed, even if prose says proceed", async () => {
		const { execute } = fakeExecute(["Verdict: proceed\n```json\n{not valid json}\n```"]);
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 2, loopId: "S3", execute });
		const it = firstIteration("S3");
		expect(it.verdict).toBe("block");
		expect(it.findingCount).toBe(0);
		expect(it.checksRun).toBe("unreported");
		expect(stopStatus("S3")).toBe("blocked");
	});

	test("parses the LAST fenced JSON block when the prose has an earlier one", async () => {
		// The prose includes an example block (proceed); the real verdict block
		// (block) comes last. The driver must parse the last one — if it parsed the
		// first, the loop would wrongly converge.
		const review = [
			"Example of the block you must emit:",
			"```json",
			JSON.stringify({ verdict: "proceed", findingCount: 0, checksRun: "example", risk: "none" }),
			"```",
			"My actual verdict:",
			"```json",
			JSON.stringify({ verdict: "block", findingCount: 4, checksRun: "bun test", risk: "high" }),
			"```",
		].join("\n");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "did it", review },
			trace: [{ type: "step.completed", stepId: "review", output: review, durationMs: 10 }],
		});
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "C1",
			execute,
		});
		expect(res.status).toBe("blocked");
		const it = firstIteration("C1");
		expect(it.verdict).toBe("block");
		expect(it.findingCount).toBe(4);
		expect(it.checksRun).toBe("bun test");
	});

	test("changedFiles records staged and untracked files, not just unstaged diffs", async () => {
		// A real git repo in cwd so gitChangedFiles runs against it. A staged file
		// and an untracked file must both appear — `git diff --name-only` alone
		// would omit them (the bug: a brand-new file would not be recorded).
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		git(["init"]);
		writeFileSync(join(cwd, "staged.ts"), "export const a = 1;\n");
		git(["add", "staged.ts"]);
		writeFileSync(join(cwd, "untracked.ts"), "export const b = 2;\n");

		const { execute } = fakeExecute([reviewJson("proceed")]);
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "GIT1", execute });
		const it = firstIteration("GIT1");
		expect(it.changedFiles).toContain("staged.ts");
		expect(it.changedFiles).toContain("untracked.ts");
	});

	test("a failed manifest run closes the loop as blocked with a clear reason", async () => {
		const execute: ConvergeExecute = async () => ({
			ok: false,
			failedStep: "review",
			error: "codex exited 1",
			outputs: { implement: "partial" },
			trace: [],
		});
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "F1",
			execute,
		});
		expect(res.status).toBe("blocked");
		expect(res.iterations).toBe(0);
		const s = stopRecord("F1");
		expect(s?.status).toBe("blocked");
		expect(s?.reason).toMatch(/manifest run failed at step "review"/);
		expect(s?.reason).toMatch(/codex exited 1/);
		// The failed run appended no iteration record.
		expect(readLoop(cwd, "F1").filter((r) => r.type === "iteration")).toHaveLength(0);
	});
});

describe("runConverge (CLI)", () => {
	test("an unexpected fs error exits 1 with a clean message, not a raw stack", async () => {
		// --cwd points at a regular file, so startLoop's mkdirSync(.chit/loops)
		// throws a raw ENOTDIR (not a ConvergeError); it must still surface cleanly
		// via the final catch, mirroring loop-log's discipline.
		const filePath = join(cwd, "not-a-dir");
		writeFileSync(filePath, "x");
		const out: string[] = [];
		const err: string[] = [];
		const io: ConvergeIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
		const code = await runConverge(
			["--task", "t", "--scope", "s", "--cwd", filePath, "--loop-id", "L1"],
			io,
		);
		expect(code).toBe(1);
		// A clean `chit converge:` error line that is not one of the permission
		// warnings — i.e. the fs error surfaced as a message, not a raw stack.
		const errorLine = err
			.join("")
			.split("\n")
			.find((l) => l.startsWith("chit converge: ") && !l.includes("WARNING"));
		expect(errorLine).toBeDefined();
	});

	test("a failed manifest run exits 1 with a clean message (not a 0 success)", async () => {
		// A fake `claude` that exits non-zero makes the first (implement) step fail,
		// so the manifest run returns ok:false. The driver must close the loop as
		// blocked AND exit 1 — a failed run is never reported as success.
		const binDir = join(cwd, "bin");
		mkdirSync(binDir, { recursive: true });
		const claudePath = join(binDir, "claude");
		writeFileSync(claudePath, "#!/bin/sh\ncat > /dev/null\nexit 7\n");
		chmodSync(claudePath, 0o755);

		const saved = {
			PATH: process.env.PATH,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		};
		// Prepend the fake bin so our `claude` wins; point config at an empty dir so
		// loadRegistry yields the built-in agents (claude -> claude-cli).
		process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
		process.env.XDG_CONFIG_HOME = cwd;
		process.env.XDG_STATE_HOME = cwd;
		try {
			const out: string[] = [];
			const err: string[] = [];
			const io: ConvergeIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
			const code = await runConverge(
				["--task", "t", "--scope", "s", "--cwd", cwd, "--loop-id", "FAILCLI"],
				io,
			);
			expect(code).toBe(1);
			// No success summary was printed to stdout.
			expect(out.join("")).not.toContain("status:");
			const errorLine = err
				.join("")
				.split("\n")
				.find((l) => l.startsWith("chit converge: ") && !l.includes("WARNING"));
			expect(errorLine).toBeDefined();
			// The loop was still recorded as a blocked stop, not left open.
			expect(stopStatus("FAILCLI")).toBe("blocked");
		} finally {
			restoreEnv(saved);
		}
	});

	test("an invalid registry exits 1 with a clean message", async () => {
		// An unreadable ~/.config/handoff/agents.json makes loadRegistry throw a
		// RegistryError; it must surface as a clean `chit converge:` line, not a
		// raw Bun stack.
		const configDir = join(cwd, "handoff");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "agents.json"), "{ not valid json");

		const saved = {
			PATH: process.env.PATH,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		};
		process.env.XDG_CONFIG_HOME = cwd;
		try {
			const out: string[] = [];
			const err: string[] = [];
			const io: ConvergeIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
			const code = await runConverge(
				["--task", "t", "--scope", "s", "--cwd", cwd, "--loop-id", "BADREG"],
				io,
			);
			expect(code).toBe(1);
			expect(err.join("")).toMatch(/^chit converge: /m);
		} finally {
			restoreEnv(saved);
		}
	});

	// A converge-shaped manifest (implement + review call steps) whose reviewer is
	// claude with read_only — claude-cli cannot enforce read_only, so this has an
	// enforcement gap (unlike the default converge.json, where the reviewer is
	// codex). `gap: false` swaps the reviewer to write to remove the gap.
	function writeGapManifest(gap: boolean): string {
		const reviewerPerms = gap ? "read_only" : "write";
		const manifest = {
			schema: 1,
			id: "converge-gap-test",
			description: "test",
			inputs: { task: { type: "string" }, prior_review: { type: "string", optional: true } },
			participants: {
				implementer: {
					agent: "claude",
					role: "implement",
					session: "stateless",
					permissions: { filesystem: "write" },
				},
				reviewer: {
					agent: "claude",
					role: "review",
					session: "stateless",
					permissions: { filesystem: reviewerPerms },
				},
			},
			steps: {
				implement: { call: "implementer", prompt: "{{ inputs.task }} {{ inputs.prior_review }}" },
				review: { call: "reviewer", prompt: "{{ steps.implement.output }}" },
				out: { format: "{{ steps.implement.output }} {{ steps.review.output }}" },
			},
			output: "out",
		};
		const path = join(cwd, "gap-manifest.json");
		writeFileSync(path, JSON.stringify(manifest));
		return path;
	}

	test("an enforcement gap without the flag exits 1 with a clean error", async () => {
		const manifestPath = writeGapManifest(true);
		const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		process.env.XDG_CONFIG_HOME = cwd; // built-in registry (claude -> claude-cli)
		try {
			const err: string[] = [];
			const io: ConvergeIO = { out: () => {}, err: (s) => err.push(s) };
			const code = await runConverge(
				[
					"--task",
					"t",
					"--scope",
					"s",
					"--cwd",
					cwd,
					"--loop-id",
					"GAP1",
					"--manifest",
					manifestPath,
				],
				io,
			);
			expect(code).toBe(1);
			expect(err.join("")).toMatch(/cannot enforce required permissions/);
			expect(err.join("")).toMatch(/reviewer/);
			// It refused before running, so no loop log was created.
			expect(() => readLoop(cwd, "GAP1")).toThrow();
		} finally {
			restoreEnv(saved);
		}
	});

	test("an enforcement gap WITH the flag passes the governance gate", async () => {
		// With the flag the gate is bypassed (a warning is emitted) and the loop
		// proceeds to run. A fake `claude` that exits non-zero makes the run fail,
		// which proves we got past the gate (the error is a run failure, not the
		// enforce refusal).
		const manifestPath = writeGapManifest(true);
		const binDir = join(cwd, "bin");
		mkdirSync(binDir, { recursive: true });
		const claudePath = join(binDir, "claude");
		writeFileSync(claudePath, "#!/bin/sh\ncat > /dev/null\nexit 7\n");
		chmodSync(claudePath, 0o755);

		const saved = {
			PATH: process.env.PATH,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		};
		process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
		process.env.XDG_CONFIG_HOME = cwd;
		process.env.XDG_STATE_HOME = cwd;
		try {
			const err: string[] = [];
			const io: ConvergeIO = { out: () => {}, err: (s) => err.push(s) };
			const code = await runConverge(
				[
					"--task",
					"t",
					"--scope",
					"s",
					"--cwd",
					cwd,
					"--loop-id",
					"GAP2",
					"--manifest",
					manifestPath,
					"--allow-unenforced-permissions",
				],
				io,
			);
			const errText = err.join("");
			// Passed the gate: no enforce refusal, just the warning, then it ran.
			expect(errText).not.toMatch(/cannot enforce required permissions/);
			expect(errText).toMatch(/WARNING -- unenforced permission/);
			// It proceeded to run; the fake claude failed, so the loop was recorded.
			expect(code).toBe(1);
			expect(stopStatus("GAP2")).toBe("blocked");
		} finally {
			restoreEnv(saved);
		}
	});

	test("a non-converge-shaped manifest (missing review step) exits 1 with a clean error", async () => {
		const manifest = {
			schema: 1,
			id: "not-converge",
			description: "test",
			inputs: { task: { type: "string" } },
			participants: {
				implementer: {
					agent: "claude",
					role: "implement",
					session: "stateless",
					permissions: { filesystem: "write" },
				},
			},
			steps: {
				implement: { call: "implementer", prompt: "{{ inputs.task }}" },
				out: { format: "{{ steps.implement.output }}" },
			},
			output: "out",
		};
		const manifestPath = join(cwd, "not-converge.json");
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const out: string[] = [];
		const err: string[] = [];
		const io: ConvergeIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
		const code = await runConverge(
			[
				"--task",
				"t",
				"--scope",
				"s",
				"--cwd",
				cwd,
				"--loop-id",
				"SHAPE1",
				"--manifest",
				manifestPath,
			],
			io,
		);
		expect(code).toBe(1);
		expect(err.join("")).toMatch(/not converge-shaped/);
		expect(err.join("")).toMatch(/review/);
		// Refused before running: no loop log.
		expect(() => readLoop(cwd, "SHAPE1")).toThrow();
	});

	// Write a manifest to disk and run converge against it; returns exit code and
	// joined stderr. Used by the shape-validation cases below.
	async function runConvergeOnManifest(
		manifestObj: unknown,
		loopId: string,
	): Promise<{ code: number; err: string }> {
		const manifestPath = join(cwd, `${loopId}.json`);
		writeFileSync(manifestPath, JSON.stringify(manifestObj));
		const err: string[] = [];
		const io: ConvergeIO = { out: () => {}, err: (s) => err.push(s) };
		const code = await runConverge(
			[
				"--task",
				"t",
				"--scope",
				"s",
				"--cwd",
				cwd,
				"--loop-id",
				loopId,
				"--manifest",
				manifestPath,
			],
			io,
		);
		return { code, err: err.join("") };
	}

	test("a manifest missing the implement step exits 1 with a clean error", async () => {
		const { code, err } = await runConvergeOnManifest(
			{
				schema: 1,
				id: "missing-implement",
				description: "test",
				inputs: { task: { type: "string" } },
				participants: {
					reviewer: {
						agent: "claude",
						role: "review",
						session: "stateless",
						permissions: { filesystem: "write" },
					},
				},
				steps: {
					review: { call: "reviewer", prompt: "{{ inputs.task }}" },
					out: { format: "{{ steps.review.output }}" },
				},
				output: "out",
			},
			"SHAPE2",
		);
		expect(code).toBe(1);
		expect(err).toMatch(/not converge-shaped/);
		expect(err).toMatch(/implement/);
		expect(() => readLoop(cwd, "SHAPE2")).toThrow();
	});

	test("a manifest whose implement/review are not call steps exits 1 with a clean error", async () => {
		const { code, err } = await runConvergeOnManifest(
			{
				schema: 1,
				id: "noncall",
				description: "test",
				inputs: { task: { type: "string" } },
				participants: {
					worker: {
						agent: "claude",
						role: "worker",
						session: "stateless",
						permissions: { filesystem: "write" },
					},
				},
				steps: {
					implement: { format: "{{ inputs.task }}" },
					review: { format: "{{ steps.implement.output }}" },
					out: { format: "{{ steps.review.output }}" },
				},
				output: "out",
			},
			"SHAPE3",
		);
		expect(code).toBe(1);
		expect(err).toMatch(/not converge-shaped/);
		// implement is checked first, so the error names it specifically.
		expect(err).toMatch(/"implement" must be a call step/);
		expect(() => readLoop(cwd, "SHAPE3")).toThrow();
	});
});
