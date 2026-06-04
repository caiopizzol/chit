import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type NormalizedRegistry,
	parseManifest,
	type RequiredCheck,
	resolveManifest,
} from "@chit-run/core";

// buildExecute / makeAuditedExecute / validateConvergeManifest / resolveLoopPolicy
// consume a ResolvedManifest now (the type-safety invariant). These fixtures are
// fully inline, so resolution is a no-op beyond adding provenance.
function resolved(raw: unknown) {
	return resolveManifest(parseManifest(raw), { roles: {} });
}

import { AuditStore } from "../audit/store.ts";
import { readLoop, startLoop } from "../loops/log-store.ts";
import type { AdapterMap } from "../runtime/types.ts";
import { FileSessionStore } from "../sessions/store.ts";
import {
	type ConvergeExecute,
	type ConvergeIO,
	convergeLoop,
	makeAuditedExecute,
	resolveLoopPolicy,
	runConverge,
	runConvergeIteration,
	stopReasonFor,
	validateConvergeManifest,
} from "./converge.ts";

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
	extra: { findingCount?: number; checksRun?: string; checks?: unknown[] } = {},
): string {
	// A normal proceeding review reports passing checks, so default `checks` to one
	// passed entry: `proceed` then converges (verification passed). Tests exercising
	// the unverified paths pass `checks` explicitly (failed / blocked / [] / malformed).
	const block = {
		verdict,
		findingCount: extra.findingCount ?? 0,
		checks: extra.checks ?? [{ command: "bun run test", status: "passed" }],
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
				checks: [{ command: "bun test; tsc", status: "passed" }],
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

	test("records structured checks + derives verification (failed dominates)", async () => {
		const review = [
			"Reviewed the diff.",
			"```json",
			JSON.stringify({
				verdict: "proceed",
				findingCount: 0,
				checks: [
					{ command: "bun run typecheck", status: "passed" },
					{ command: "bun run test", status: "failed", reason: "2 failed in board.test.ts" },
				],
				checksRun: "typecheck + test",
				risk: "none",
			}),
			"```",
		].join("\n");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "did it", review },
			trace: [],
		});
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 3, loopId: "V1", execute });
		const it = firstIteration("V1");
		expect(it.checks).toEqual([
			{ command: "bun run typecheck", status: "passed" },
			{ command: "bun run test", status: "failed", reason: "2 failed in board.test.ts" },
		]);
		expect(it.verification).toBe("failed");
	});

	test("records verification not_run (omitting the empty checks list) when the reviewer reports none", async () => {
		// not_run is exactly when a proceed stops needs-decision, so the record MUST
		// carry the rollup or chit_trace cannot show why. The empty checks list adds
		// nothing the rollup does not already say, so it stays omitted.
		const { execute } = fakeExecute([reviewJson("proceed", { checks: [] })]);
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 3, loopId: "V2", execute });
		const it = firstIteration("V2");
		expect("checks" in it).toBe(false);
		expect(it.verification).toBe("not_run");
	});

	// The gate: a proceed verdict converges ONLY when verification passed. Otherwise
	// (failed / blocked / not_run / a malformed report) the loop stops needs-decision,
	// so chit never presents success the checks do not support.
	const gateRun = async (loopId: string, review: string) => {
		const { execute } = fakeExecute([review]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId,
			execute,
		});
		return { status: res.status, it: firstIteration(loopId) };
	};

	test("proceed + all checks passed -> converged", async () => {
		const { status } = await gateRun(
			"G1",
			reviewJson("proceed", { checks: [{ command: "bun test", status: "passed" }] }),
		);
		expect(status).toBe("converged");
	});

	test("proceed + a failed check -> needs-decision (not converged)", async () => {
		const { status, it } = await gateRun(
			"G2",
			reviewJson("proceed", {
				checks: [{ command: "bun test", status: "failed", reason: "2 failed" }],
			}),
		);
		expect(it.verification).toBe("failed");
		expect(status).toBe("needs-decision");
	});

	test("proceed + a blocked check -> needs-decision", async () => {
		const { status, it } = await gateRun(
			"G3",
			reviewJson("proceed", {
				checks: [{ command: "bun test", status: "blocked", reason: "read-only sandbox" }],
			}),
		);
		expect(it.verification).toBe("blocked");
		expect(status).toBe("needs-decision");
	});

	test("proceed + no checks (not_run) -> needs-decision, verification not_run recorded", async () => {
		const { status, it } = await gateRun("G4", reviewJson("proceed", { checks: [] }));
		expect(it.verification).toBe("not_run");
		expect(status).toBe("needs-decision");
	});

	test("proceed + a malformed check cannot roll up to passed -> needs-decision", async () => {
		// One valid passed entry + one garbled entry (bad status). Dropping the
		// garbled one must NOT let the rollup become passed: verification is blocked.
		const { status, it } = await gateRun(
			"G5",
			reviewJson("proceed", {
				checks: [
					{ command: "bun typecheck", status: "passed" },
					{ command: "bun test", status: "FAIL" },
				],
			}),
		);
		expect(it.verification).toBe("blocked");
		expect(status).toBe("needs-decision");
	});

	test("proceed + ONLY a malformed check -> needs-decision, verification blocked recorded", async () => {
		// No valid checks survive parsing (the lone entry has a bad status), so the
		// rollup is blocked -- and it must be recorded even with no valid checks, or the
		// trace hides why this stopped needs-decision (the gap the review caught).
		const { status, it } = await gateRun(
			"G6",
			reviewJson("proceed", { checks: [{ command: "bun test", status: "FAIL" }] }),
		);
		expect("checks" in it).toBe(false); // none were valid, so no list is recorded
		expect(it.verification).toBe("blocked");
		expect(status).toBe("needs-decision");
	});

	test("block stays blocked regardless of passing checks", async () => {
		const { status } = await gateRun(
			"G6",
			reviewJson("block", { checks: [{ command: "bun test", status: "passed" }] }),
		);
		expect(status).toBe("blocked");
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

	test("links the iteration to its audit run via auditRef when execute returns an auditRunId", async () => {
		const review = reviewJson("proceed");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "x", review },
			trace: [],
			auditRunId: "abc-123",
		});
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "D1", execute });
		expect(firstIteration("D1").auditRef).toBe("abc-123");
	});

	test("omits auditRef when execute returns no auditRunId", async () => {
		const { execute } = fakeExecute([reviewJson("proceed")]);
		await convergeLoop({ cwd, scope: "s", task: "t", maxIterations: 1, loopId: "D2", execute });
		expect("auditRef" in firstIteration("D2")).toBe(false);
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
		// loadConfig yields the built-in agents (claude -> claude-cli).
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

	test("an invalid config exits 1 with a clean message", async () => {
		// An unreadable ~/.config/chit/config.json makes loadConfig throw a
		// ConfigError; it must surface as a clean `chit converge:` line, not a
		// raw Bun stack. (config.json is the single read path now; agents.json is
		// no longer read.)
		const configDir = join(cwd, "chit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "{ not valid json");

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
	// claude with read_only. claude-cli now enforces read_only via plan mode, so
	// this manifest has no enforcement gap and runs without the override flag. The
	// param picks the reviewer's filesystem permission.
	function writeClaudeReviewerManifest(readOnly: boolean): string {
		const reviewerPerms = readOnly ? "read_only" : "write";
		const manifest = {
			schema: 1,
			id: "converge-gap-test",
			description: "test",
			inputs: { task: { type: "string" }, prior_review: { type: "string", optional: true } },
			participants: {
				implementer: {
					agent: "claude",
					instructions: "implement",
					session: "stateless",
					permissions: { filesystem: "write" },
				},
				reviewer: {
					agent: "claude",
					instructions: "review",
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

	test("a claude read_only reviewer runs without the override flag (plan mode enforces)", async () => {
		// claude-cli enforces read_only via plan mode, so a read_only reviewer is no
		// longer an enforcement gap: converge proceeds without
		// --allow-unenforced-permissions and emits no unenforced-permission warning.
		// A fake `claude` that exits non-zero makes the run fail, which proves we got
		// past the governance gate (a run failure, not an enforce refusal).
		const manifestPath = writeClaudeReviewerManifest(true);
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
					"GAP1",
					"--manifest",
					manifestPath,
				],
				io,
			);
			const errText = err.join("");
			// Passed the gate without the flag: no enforce refusal, no warning.
			expect(errText).not.toMatch(/cannot enforce required permissions/);
			expect(errText).not.toMatch(/WARNING -- unenforced permission/);
			// It proceeded to run; the fake claude failed, so the loop was recorded.
			expect(code).toBe(1);
			expect(stopStatus("GAP1")).toBe("blocked");
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
					instructions: "implement",
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
						instructions: "review",
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
						instructions: "worker",
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

describe("runConvergeIteration (single-iteration primitive)", () => {
	// The primitive does not start or stop the loop, so each test opens a loop
	// first (so appendIteration has an open loop to write to) and asserts on the
	// returned next-state plus the appended iteration record.
	test("runs one iteration with prior_review and returns next-state for revise", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "IT1" });
		const review = reviewJson("revise", { findingCount: 3, checksRun: "bun test" });
		const calls: { task: string; prior_review: string }[] = [];
		const execute: ConvergeExecute = async (inputs) => {
			calls.push(inputs);
			return {
				ok: true,
				output: "",
				outputs: { implement: "did it", review },
				trace: [{ type: "step.completed", stepId: "review", output: review, durationMs: 42 }],
			};
		};

		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 2,
			task: "t",
			prior_review: "earlier review",
			execute,
		});

		// The injected prior_review reached execute for this iteration.
		expect(calls[0]?.prior_review).toBe("earlier review");
		// Next-state: revise leaves stopStatus undefined (caller continues) and
		// returns the review text to thread as the next prior_review.
		if (!res.ok) throw new Error("expected ok iteration");
		expect(res.verdict).toBe("revise");
		expect(res.decision).toBe("revise");
		expect(res.findingCount).toBe(3);
		expect(res.checksRun).toBe("bun test");
		expect(res.stopStatus).toBeUndefined();
		expect(res.reviewText).toBe(review);
		expect(res.auditRunId).toBeUndefined();
		// The iteration record was appended with the parsed verdict/metrics.
		const it = firstIteration(loopId);
		expect(it.verdict).toBe("revise");
		expect(it.findingCount).toBe(3);
		expect(it.checksRun).toBe("bun test");
		expect(it.checkDurationMs).toBe(42);
	});

	test("proceed yields stopStatus converged and surfaces auditRunId", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT2" });
		const review = reviewJson("proceed");
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "x", review },
			trace: [],
			auditRunId: "run-9",
		});
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		if (!res.ok) throw new Error("expected ok iteration");
		expect(res.verdict).toBe("proceed");
		expect(res.stopStatus).toBe("converged");
		expect(res.auditRunId).toBe("run-9");
		// The audit link is threaded into the iteration record's auditRef.
		expect(firstIteration(loopId).auditRef).toBe("run-9");
	});

	test("block yields stopStatus blocked", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT3" });
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "x", review: reviewJson("block") },
			trace: [],
		});
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		if (!res.ok) throw new Error("expected ok iteration");
		expect(res.verdict).toBe("block");
		expect(res.stopStatus).toBe("blocked");
	});

	test("a failed run returns { ok: false, failure } and appends no iteration record", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT4" });
		const execute: ConvergeExecute = async () => ({
			ok: false,
			failedStep: "review",
			error: "codex exited 1",
			outputs: { implement: "partial" },
			trace: [],
		});
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failed iteration");
		expect(res.failure).toMatch(/manifest run failed at step "review"/);
		expect(res.failure).toMatch(/codex exited 1/);
		// No iteration record was appended for the failed run.
		expect(readLoop(cwd, loopId).filter((r) => r.type === "iteration")).toHaveLength(0);
	});

	test("a failed run still surfaces auditRunId when the run was audited", async () => {
		// A graceful failure can still have a clean audit transcript on disk (the
		// audited execute recorded it before the step failed). The primitive must
		// pass that ref through so the caller can keep the link instead of orphaning it.
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT4b" });
		const execute: ConvergeExecute = async () => ({
			ok: false,
			failedStep: "review",
			error: "codex exited 1",
			outputs: { implement: "partial" },
			trace: [],
			auditRunId: "audit-on-failure",
		});
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failed iteration");
		expect(res.auditRunId).toBe("audit-on-failure");
	});

	test("an execute throw propagates and appends no iteration record", async () => {
		// A run that THROWS (not a graceful ok:false) must propagate out of the
		// primitive so the caller can close the loop as blocked; no iteration record
		// is appended for a thrown run.
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT6" });
		const execute: ConvergeExecute = async () => {
			throw new Error("adapter exploded");
		};
		await expect(
			runConvergeIteration({ cwd, loopId, iteration: 1, task: "t", prior_review: "", execute }),
		).rejects.toThrow("adapter exploded");
		expect(readLoop(cwd, loopId).filter((r) => r.type === "iteration")).toHaveLength(0);
	});

	test("an unparseable verdict appends a block record and yields stopStatus blocked", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT5" });
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "x", review: "no verdict block here" },
			trace: [],
		});
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		if (!res.ok) throw new Error("expected ok iteration");
		// Fail-safe: no usable block resolves to block, never an implicit proceed.
		expect(res.verdict).toBe("block");
		expect(res.stopStatus).toBe("blocked");
		expect(res.findingCount).toBe(0);
		expect(res.checksRun).toBe("unreported");
		expect(firstIteration(loopId).verdict).toBe("block");
	});

	test("forwards ctx.signal to execute so the iteration's run is cancellable", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT6" });
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			seenSignal = ctx?.signal;
			return {
				ok: true,
				output: "",
				outputs: { implement: "x", review: reviewJson("proceed") },
				trace: [],
			};
		};
		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
			signal: controller.signal,
		});
		if (!res.ok) throw new Error("expected ok iteration");
		// The primitive passes its signal straight through to execute's ctx, which
		// is what wires Esc/chit_converge_cancel down to the adapter call.
		expect(seenSignal).toBe(controller.signal);
	});

	test("omitting ctx.signal leaves execute with no signal (CLI driver path)", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "IT7" });
		let ctxSeen: { signal?: AbortSignal } | undefined;
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctxSeen = ctx;
			return {
				ok: true,
				output: "",
				outputs: { implement: "x", review: reviewJson("proceed") },
				trace: [],
			};
		};
		await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});
		expect(ctxSeen?.signal).toBeUndefined();
	});
});

describe("converge: makeAuditedExecute (audit wiring)", () => {
	// A minimal stateless converge-shaped manifest: inputs task/prior_review (the
	// shape the driver passes), a single call step + format out. Stateless so the
	// session wrapper passes through and an empty registry suffices.
	const mini = resolved({
		schema: 1,
		id: "mini-converge",
		description: "minimal converge-shaped manifest for audit-wiring tests",
		inputs: { task: { type: "string" }, prior_review: { type: "string" } },
		requires: { can_show_markdown: true },
		participants: { worker: { agent: "codex", instructions: "do the task", session: "stateless" } },
		steps: {
			implement: { call: "worker", prompt: "{{ inputs.task }}" },
			out: { format: "{{ steps.implement.output }}" },
		},
		output: "out",
	});
	const emptyRegistry = { agents: {} } as unknown as NormalizedRegistry;
	const fakeAdapters = (): AdapterMap => ({
		codex: { call: async (r) => ({ output: `OK:${r.stepId}`, usage: { inputTokens: 7 } }) },
	});

	test("writes a full audit run and links it, with loop metadata on run.started", async () => {
		const auditStore = new AuditStore(join(cwd, "audit"));
		const execute = makeAuditedExecute(
			mini,
			fakeAdapters(),
			emptyRegistry,
			"s",
			cwd,
			new FileSessionStore(join(cwd, "sess")),
			auditStore,
		);
		const result = await execute(
			{ task: "do x", prior_review: "" },
			{ loopId: "L1", iteration: 2 },
		);
		expect(result.ok).toBe(true);
		expect(result.auditRunId).toBeDefined();

		const events = auditStore.readEvents(result.auditRunId as string);
		expect(events[0]).toMatchObject({
			type: "run.started",
			surface: "converge",
			loopId: "L1",
			iteration: 2,
		});
		expect(events[events.length - 1]?.type).toBe("run.completed");
		expect(events.some((e) => e.type === "adapter.call.completed")).toBe(true);
	});

	test("withholds auditRunId (no dangling link) when the audit store fails, run still succeeds", async () => {
		const broken = {
			openRun() {
				throw new Error("disk full");
			},
			writeBlob() {
				throw new Error("disk full");
			},
			appendEvent() {
				throw new Error("disk full");
			},
		} as unknown as AuditStore;
		const execute = makeAuditedExecute(
			mini,
			fakeAdapters(),
			emptyRegistry,
			"s",
			cwd,
			new FileSessionStore(join(cwd, "sess")),
			broken,
		);
		const result = await execute({ task: "x", prior_review: "" }, { loopId: "L1", iteration: 1 });
		expect(result.ok).toBe(true); // audit is best-effort: the run still succeeds
		expect(result.auditRunId).toBeUndefined(); // but no link to a missing transcript
	});

	test("prunes old audit runs after a run, but never the just-written run", async () => {
		const auditStore = new AuditStore(join(cwd, "audit"));
		// A run whose last activity is 40 days ago: beyond the 30-day default maxAge.
		const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
		auditStore.appendEvent("OLD", {
			type: "run.started",
			runId: "OLD",
			ts: oldTs,
			manifestId: "m",
			cwd,
			surface: "converge",
		});
		const execute = makeAuditedExecute(
			mini,
			fakeAdapters(),
			emptyRegistry,
			"s",
			cwd,
			new FileSessionStore(join(cwd, "sess")),
			auditStore,
		);
		const result = await execute({ task: "x", prior_review: "" }, { loopId: "L1", iteration: 1 });
		expect(result.auditRunId).toBeDefined();
		const runs = auditStore.listRuns();
		expect(runs).not.toContain("OLD"); // pruned by the default 30-day maxAge
		expect(runs).toContain(result.auditRunId as string); // the just-written run is kept
	});
});

describe("loop policy resolution (Stage 2: policy-driven step ids)", () => {
	// A minimal converge-shaped manifest with the given top-level extras, parsed +
	// resolved (validateConvergeManifest / resolveLoopPolicy consume a ResolvedManifest).
	function parseConverge(extra: Record<string, unknown>) {
		return resolved({
			schema: 1,
			id: "c",
			description: "converge-shaped",
			inputs: { task: { type: "string" }, prior_review: { type: "string", optional: true } },
			participants: {
				impl: { agent: "claude", instructions: "implement", session: "per_scope" },
				rev: { agent: "codex", instructions: "review", session: "per_scope" },
			},
			steps: {
				implement: { call: "impl", prompt: "{{ inputs.task }}" },
				review: { call: "rev", prompt: "{{ steps.implement.output }}" },
				out: { format: "{{ steps.review.output }}" },
			},
			output: "out",
			...extra,
		});
	}

	test("a converge manifest WITH no policy falls back to implement/review (zero behavior change)", () => {
		const m = parseConverge({});
		expect(m.policy).toEqual({ kind: "one-shot" });
		// The driver still resolves the implement/review defaults, and the manifest
		// validates as converge-shaped through the fallback.
		expect(resolveLoopPolicy(m)).toEqual({ implementStep: "implement", reviewStep: "review" });
		expect(validateConvergeManifest(m)).toBeNull();
	});

	test("a loop policy resolves to its declared step ids", () => {
		const m = parseConverge({
			policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
		});
		expect(resolveLoopPolicy(m)).toEqual({ implementStep: "implement", reviewStep: "review" });
		expect(validateConvergeManifest(m)).toBeNull();
	});

	test("runConvergeIteration keys outputs + checkDuration on the configured steps, not literals", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "POL1" });
		const review = reviewJson("proceed", { findingCount: 1, checksRun: "bun test" });
		// The run reports its outputs/trace under NON-default step names (build/check).
		// A driver still hardwired to implement/review would read undefined here.
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { build: "built the slice", check: review },
			trace: [{ type: "step.completed", stepId: "check", output: review, durationMs: 1234 }],
		});

		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
			implementStep: "build",
			reviewStep: "check",
		});

		if (!res.ok) throw new Error("expected ok iteration");
		// Verdict parsed from outputs["check"], not outputs["review"].
		expect(res.verdict).toBe("proceed");
		expect(res.findingCount).toBe(1);
		const it = firstIteration(loopId);
		// implementSummary came from outputs["build"], not outputs["implement"].
		expect(it.implementSummary).toContain("built the slice");
		// checkDurationMs measured the "check" step, not a literal "review".
		expect(it.checkDurationMs).toBe(1234);
	});

	test("default step ids: a run reporting build/check is NOT misread as implement/review", async () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "POL2" });
		const review = reviewJson("proceed");
		// No implementStep/reviewStep on the context -> defaults implement/review.
		// The run's outputs are under build/check, so the defaults find nothing:
		// proves the reads are genuinely keyed (an empty review text fails safe to
		// block, and the implement summary is empty).
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { build: "built it", check: review },
			trace: [{ type: "step.completed", stepId: "check", output: review, durationMs: 99 }],
		});

		const res = await runConvergeIteration({
			cwd,
			loopId,
			iteration: 1,
			task: "t",
			prior_review: "",
			execute,
		});

		if (!res.ok) throw new Error("expected ok iteration");
		// outputs["review"] was absent -> empty text -> fail-safe block verdict.
		expect(res.verdict).toBe("block");
		const it = firstIteration(loopId);
		// outputs["implement"] absent -> empty summary -> the "(no summary)" fallback.
		expect(it.implementSummary).toBe("(no summary)");
		expect(it.checkDurationMs).toBe(0); // no "review" step in the trace
	});
});

describe("stopReasonFor (the one wording source for every loop driver)", () => {
	test("verdict and budget outcomes get fixed, honest wording", () => {
		// converged names verification, so it can never read as proceed-alone.
		expect(stopReasonFor("converged")).toBe("reviewer returned proceed and verification passed");
		expect(stopReasonFor("blocked")).toBe("reviewer returned block");
		// The bug this guards: needs-decision must NOT say "reviewer returned block".
		const nd = stopReasonFor("needs-decision");
		expect(nd).toContain("verification did not pass");
		expect(nd).not.toContain("returned block");
	});

	test("max-iterations includes the budget when given, omits it otherwise", () => {
		expect(stopReasonFor("max-iterations", { maxIterations: 3 })).toBe(
			"reached max iterations (3) without converging",
		);
		expect(stopReasonFor("max-iterations")).toBe("reached max iterations without converging");
	});

	test("cancellation carries the site detail, defaulting to plain cancelled", () => {
		expect(stopReasonFor("cancelled")).toBe("cancelled");
		expect(stopReasonFor("cancelled", { detail: "mid-iteration (signal)" })).toBe(
			"cancelled mid-iteration (signal)",
		);
	});
});

describe("chit-executed required checks (authoritative over the reviewer's self-report)", () => {
	// Real binaries (like the runner's own tests): true/false/sleep. The reviewer's
	// self-reported checks in reviewJson are IGNORED on the chit path -- chit runs its own.
	const PASS: RequiredCheck = { command: "true", args: [] };
	const FAIL: RequiredCheck = { command: "false", args: [] };
	const BLOCK: RequiredCheck = { command: "sleep", args: ["5"], timeoutMs: 50 };

	const run = async (
		loopId: string,
		review: string,
		requiredChecks: RequiredCheck[],
		maxIterations = 1,
	) => {
		const { execute } = fakeExecute([review]);
		const res = await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations,
			loopId,
			execute,
			requiredChecks,
		});
		return { status: res.status, it: firstIteration(loopId) };
	};

	test("reviewer proceed + all chit checks pass -> converged, verificationSource chit", async () => {
		const { status, it } = await run("C1", reviewJson("proceed"), [PASS]);
		expect(status).toBe("converged");
		expect(it.verification).toBe("passed");
		expect(it.verificationSource).toBe("chit");
		expect(it.decision).toBe("proceed");
	});

	test("reviewer proceed + a failed chit check -> the decision diverges to revise", async () => {
		// maxIterations 1: the iteration is a revise (no stop), so the budget runs out and
		// the LOOP stops max-iterations -- but the ITERATION records decision revise.
		const { status, it } = await run("C2", reviewJson("proceed"), [PASS, FAIL]);
		expect(it.verdict).toBe("proceed"); // the reviewer approved
		expect(it.decision).toBe("revise"); // chit overrode it: a real declared check failed
		expect(it.verification).toBe("failed");
		expect(it.verificationSource).toBe("chit");
		expect(status).toBe("max-iterations");
	});

	test("reviewer proceed + a blocked chit check (none failed) -> needs-decision, decision stays proceed", async () => {
		const { status, it } = await run("C3", reviewJson("proceed"), [PASS, BLOCK]);
		expect(it.verification).toBe("blocked");
		// The reviewer approved and chit could not verify -- NOT a reviewer block.
		expect(it.decision).toBe("proceed");
		expect(status).toBe("needs-decision");
	});

	test("failed dominates blocked: one failed + one blocked -> revise", async () => {
		const { status, it } = await run("C4", reviewJson("proceed"), [FAIL, BLOCK]);
		expect(it.verification).toBe("failed");
		expect(it.decision).toBe("revise");
		expect(status).toBe("max-iterations");
	});

	test("reviewer revise -> chit checks are NOT run; verification stays reviewer-sourced", async () => {
		// Even though the declared check WOULD fail, a revise verdict skips chit checks.
		const { it } = await run("C5", reviewJson("revise", { checks: [] }), [FAIL]);
		expect(it.decision).toBe("revise");
		expect(it.verificationSource).toBe("reviewer");
	});

	test("reviewer block -> chit checks are NOT run; blocked, reviewer-sourced", async () => {
		const { status, it } = await run("C6", reviewJson("block"), [PASS]);
		expect(status).toBe("blocked");
		expect(it.verificationSource).toBe("reviewer");
	});

	test("a failed chit check feeds its failures into the next prior_review (failure first)", async () => {
		const { execute, calls } = fakeExecute([reviewJson("proceed"), reviewJson("proceed")]);
		await convergeLoop({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 2,
			loopId: "C7",
			execute,
			requiredChecks: [FAIL],
		});
		expect(calls[0]?.prior_review).toBe(""); // iteration 1 has no prior review
		const fed = calls[1]?.prior_review ?? "";
		expect(fed).toContain("These checks failed:"); // chit's failure summary...
		expect(fed).toContain("Reviewer notes:"); // ...then the reviewer's text
		expect(fed.indexOf("These checks failed:")).toBeLessThan(fed.indexOf("Reviewer notes:"));
	});
});
