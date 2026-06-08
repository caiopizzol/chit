import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLoopReceipt,
	type LoopIterationRecord,
	type LoopStopRecord,
	type RequiredCheck,
} from "@chit-run/core";
import type { ConvergeExecute } from "../../cli/converge.ts";
import { readLoop } from "../../loops/log-store.ts";
import type { TraceEvent } from "../../runtime/types.ts";
import {
	ConvergeEngineError,
	cancelConverge,
	describeConverge,
	type LoopPhase,
	runNextIteration,
	startConvergeSession,
	traceConverge,
} from "./converge-engine.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-converge-engine-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function reviewJson(
	verdict: string,
	extra: { findingCount?: number; checksRun?: string; checks?: unknown[] } = {},
): string {
	// Default to a passing check so a `proceed` converges (verification === passed);
	// the gate sends proceed-without-passing-checks to needs-decision.
	const block = {
		verdict,
		findingCount: extra.findingCount ?? 0,
		checks: extra.checks ?? [{ command: "bun test", status: "passed" }],
		checksRun: extra.checksRun ?? "none",
		risk: "none",
	};
	return `Reviewed.\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``;
}

// A fake execute mirroring executeManifest's contract, including its
// cancellation behavior: when the iteration's signal is aborted, the real
// executeManifest turns the adapter rejection into a graceful ok:false failure
// envelope (NOT a throw), so this fake does the same.
function scriptedExecute(reviews: string[], opts: { auditRunId?: string } = {}): ConvergeExecute {
	let i = 0;
	return async (_inputs, ctx) => {
		if (ctx?.signal?.aborted) {
			return {
				ok: false,
				failedStep: "implement",
				error: "aborted",
				outputs: {} as Record<string, string>,
				trace: [],
			};
		}
		const review = reviews[i++] ?? "";
		return {
			ok: true,
			output: "",
			outputs: { implement: "did it", review },
			trace: [{ type: "step.completed", stepId: "review", output: review, durationMs: 10 }],
			...(opts.auditRunId !== undefined && { auditRunId: opts.auditRunId }),
		};
	};
}

// A controllable execute for in-flight / abort-during tests: it signals when it
// starts, then parks until either release() resolves it ok:true, or its signal
// aborts and it resolves ok:false (the executeManifest abort contract).
function gatedExecute(review: string): {
	execute: ConvergeExecute;
	onStarted: Promise<void>;
	release: () => void;
} {
	let started!: () => void;
	const onStarted = new Promise<void>((r) => {
		started = r;
	});
	let release!: () => void;
	const execute: ConvergeExecute = (_inputs, ctx) =>
		new Promise((resolve) => {
			started();
			release = () =>
				resolve({ ok: true, output: "", outputs: { implement: "x", review }, trace: [] });
			const onAbort = () =>
				resolve({
					ok: false,
					failedStep: "implement",
					error: "aborted",
					outputs: {} as Record<string, string>,
					trace: [],
				});
			const sig = ctx?.signal;
			if (sig?.aborted) onAbort();
			else sig?.addEventListener("abort", onAbort, { once: true });
		});
	return { execute, onStarted, release: () => release() };
}

function start(execute: ConvergeExecute, maxIterations = 3) {
	return startConvergeSession({ cwd, scope: "s", task: "t", maxIterations, execute, loopId: "L1" });
}

function iterations(loopId: string): LoopIterationRecord[] {
	return readLoop(cwd, loopId).filter((r): r is LoopIterationRecord => r.type === "iteration");
}
function stopRecord(loopId: string): LoopStopRecord | undefined {
	return readLoop(cwd, loopId).find((r): r is LoopStopRecord => r.type === "stop");
}

describe("startConvergeSession", () => {
	test("writes a loop-log header and opens the session", () => {
		const session = start(scriptedExecute([]));
		expect(session.loopId).toBe("L1");
		expect(session.iteration).toBe(0);
		expect(session.terminalStatus).toBeUndefined();
		const records = readLoop(cwd, "L1");
		expect(records[0]?.type).toBe("loop");
		expect(records.some((r) => r.type === "stop")).toBe(false);
		expect(describeConverge(session).status).toBe("open");
	});

	test("a managed-worktree session records all five workspace fields in the loop header (#100 slice B)", () => {
		const participants = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-opus-4" },
			},
		};
		startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "WL1",
			execute: scriptedExecute([]),
			worktree: {
				worktreePath: "/wt/WL1/owner",
				branch: "chit-run/WL1/owner",
				baseSha: "basesha",
				repo: "/main/repo",
				callerCheckout: "/launching/checkout",
			},
			participants,
		});
		// the durable HEADER carries the metadata, so a closed run is recoverable from the log.
		const header = readLoop(cwd, "WL1")[0] as unknown as Record<string, unknown>;
		expect(header.worktreePath).toBe("/wt/WL1/owner");
		expect(header.branch).toBe("chit-run/WL1/owner");
		expect(header.baseSha).toBe("basesha");
		expect(header.mainRepo).toBe("/main/repo"); // opts.worktree.repo -> header.mainRepo
		expect(header.callerCheckout).toBe("/launching/checkout");
		expect(header.participants).toEqual(participants);
	});
});

describe("runNextIteration: verdict-driven stops", () => {
	test("revise leaves the loop open and threads the review into the next iteration", async () => {
		const review1 = reviewJson("revise", { findingCount: 2, checksRun: "bun test" });
		const session = start(scriptedExecute([review1, reviewJson("proceed")]));

		const r1 = await runNextIteration(session);
		expect(r1.kind).toBe("iteration");
		if (r1.kind !== "iteration") throw new Error("expected iteration");
		expect(r1.verdict).toBe("revise");
		expect(r1.stopStatus).toBeUndefined();
		expect(session.iteration).toBe(1);
		expect(session.priorReview).toBe(review1);
		expect(stopRecord("L1")).toBeUndefined(); // still open
		expect(describeConverge(session).status).toBe("open");

		const r2 = await runNextIteration(session);
		if (r2.kind !== "iteration") throw new Error("expected iteration");
		expect(r2.stopStatus).toBe("converged");
		expect(iterations("L1").length).toBe(2);
		expect(stopRecord("L1")?.status).toBe("converged");
	});

	test("proceed converges and closes the loop; a further next is rejected", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBe("converged");
		expect(session.terminalStatus).toBe("converged");
		expect(stopRecord("L1")?.status).toBe("converged");
		// Converged wording is shared with the CLI driver: it names verification, not
		// just the verdict (so "converged" can never read as proceed-alone).
		expect(stopRecord("L1")?.reason).toBe("reviewer returned proceed and verification passed");
		// Terminal: another next throws rather than appending past the stop. The
		// error is surfaced verbatim by chit_next, so it must be run-scoped: no
		// internal loop id (run_id is the only handle a caller holds).
		await expect(runNextIteration(session)).rejects.toBeInstanceOf(ConvergeEngineError);
		await expect(runNextIteration(session)).rejects.toThrow(/already converged/);
		await expect(runNextIteration(session)).rejects.not.toThrow(/loop "|loopId|L1/);
	});

	test("block closes the loop blocked", async () => {
		const session = start(scriptedExecute([reviewJson("block")]));
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBe("blocked");
		expect(stopRecord("L1")?.status).toBe("blocked");
		expect(stopRecord("L1")?.reason).toBe("reviewer returned block");
	});

	test("proceed with a failing check stops needs-decision with honest wording", async () => {
		const session = start(
			scriptedExecute([
				reviewJson("proceed", {
					checks: [{ command: "bun test", status: "failed", reason: "1 failing" }],
				}),
			]),
		);
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.verdict).toBe("proceed");
		expect(r.stopStatus).toBe("needs-decision");
		const stop = stopRecord("L1");
		expect(stop?.status).toBe("needs-decision");
		// The reason must NOT be the binary "reviewer returned block" -- that false
		// history string (the reviewer returned proceed, not block) is exactly the bug
		// this MCP path had before the wording was centralized. It must name the gate.
		expect(stop?.reason).toContain("verification did not pass");
		expect(stop?.reason).not.toContain("returned block");
	});

	test("proceed with no checks run stops needs-decision", async () => {
		const session = start(scriptedExecute([reviewJson("proceed", { checks: [] })]));
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBe("needs-decision");
		expect(stopRecord("L1")?.reason).toContain("verification did not pass");
	});

	test("an unparseable verdict fails safe to block (never an implicit proceed)", async () => {
		const session = start(scriptedExecute(["no verdict block here"]));
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.verdict).toBe("block");
		expect(r.stopStatus).toBe("blocked");
	});

	test("revise that consumes the budget stops as max-iterations", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("revise")]), 2);
		await runNextIteration(session);
		const r2 = await runNextIteration(session);
		if (r2.kind !== "iteration") throw new Error("expected iteration");
		expect(r2.stopStatus).toBe("max-iterations");
		expect(stopRecord("L1")?.status).toBe("max-iterations");
		expect(iterations("L1").length).toBe(2);
	});

	test("collects audit refs from audited iterations", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")], { auditRunId: "run-7" }));
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.auditRunId).toBe("run-7");
		expect(session.auditRefs).toEqual(["run-7"]);
		expect(iterations("L1")[0]?.auditRef).toBe("run-7");
	});

	test("an iteration result carries changedFiles and usage for the next response", async () => {
		const review = reviewJson("proceed");
		// A trace whose review step reports usage, so sumTraceUsage surfaces it.
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { implement: "x", review },
			trace: [
				{
					type: "step.completed",
					stepId: "review",
					output: review,
					durationMs: 10,
					usage: { inputTokens: 11, outputTokens: 2 },
				},
			],
		});
		const session = start(execute);
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		// changedFiles is always present (an array; empty in this non-git tmp cwd);
		// usage is surfaced when the run reported it. These are what criterion 5 of
		// issue #3 requires in the chit_converge_next response.
		expect(Array.isArray(r.changedFiles)).toBe(true);
		expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
		// And they still match the durable iteration record.
		expect(iterations("L1")[0]?.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
	});
});

describe("runNextIteration: failure (not cancellation)", () => {
	test("a graceful manifest failure closes the loop blocked with the failure reason", async () => {
		const execute: ConvergeExecute = async () => ({
			ok: false,
			failedStep: "review",
			error: "codex exploded",
			outputs: {},
			trace: [],
		});
		const session = start(execute);
		const r = await runNextIteration(session);
		expect(r.kind).toBe("failed");
		if (r.kind !== "failed") throw new Error("expected failed");
		expect(r.failure).toContain("codex exploded");
		expect(session.terminalStatus).toBe("blocked");
		expect(session.failure).toContain("codex exploded");
		// A failed run appends NO iteration record, only the blocked stop.
		expect(iterations("L1").length).toBe(0);
		expect(stopRecord("L1")?.status).toBe("blocked");
	});
});

describe("runNextIteration: cancellation", () => {
	test("an already-aborted signal records a clean cancelled stop and NO iteration", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		const controller = new AbortController();
		controller.abort();
		const r = await runNextIteration(session, { signal: controller.signal });
		expect(r.kind).toBe("cancelled");
		expect(session.terminalStatus).toBe("cancelled");
		// The crux: a cancelled iteration is never recorded as a (fake) successful
		// round. The log holds the header + a cancelled stop, zero iterations.
		expect(iterations("L1").length).toBe(0);
		expect(stopRecord("L1")?.status).toBe("cancelled");
	});

	test("aborting an in-flight iteration settles it cancelled with no iteration record", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		const controller = new AbortController();
		const pending = runNextIteration(session, { signal: controller.signal });
		await gated.onStarted; // the iteration is now in flight (active set)
		expect(session.active).toBeDefined();
		controller.abort(); // Esc / chit_converge_cancel propagates here
		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(stopRecord("L1")?.status).toBe("cancelled");
		expect(iterations("L1").length).toBe(0);
		expect(session.active).toBeUndefined();
	});
});

describe("runNextIteration: single-writer lock", () => {
	test("a second next while one is in flight is rejected", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		const pending = runNextIteration(session);
		await gated.onStarted;
		await expect(runNextIteration(session)).rejects.toBeInstanceOf(ConvergeEngineError);
		gated.release();
		const r = await pending;
		expect(r.kind).toBe("iteration");
	});
});

describe("cancelConverge", () => {
	test("closes an idle-open loop as cancelled", () => {
		const session = start(scriptedExecute([reviewJson("revise")]));
		const res = cancelConverge(session);
		expect(res.state).toBe("closed");
		expect(session.terminalStatus).toBe("cancelled");
		expect(stopRecord("L1")?.status).toBe("cancelled");
	});

	test("reports a terminal loop unchanged", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		await runNextIteration(session);
		const res = cancelConverge(session);
		expect(res).toEqual({ state: "already", status: "converged" });
	});

	test("aborts an in-flight iteration (cancelling), which then settles cancelled", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		const pending = runNextIteration(session);
		await gated.onStarted;
		const res = cancelConverge(session);
		expect(res.state).toBe("cancelling");
		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(stopRecord("L1")?.status).toBe("cancelled");
	});
});

describe("describeConverge / traceConverge", () => {
	test("status reflects open -> running -> terminal with a next action", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		expect(describeConverge(session).status).toBe("open");
		expect(describeConverge(session).nextAction).toContain("chit_converge_next");

		const pending = runNextIteration(session);
		await gated.onStarted;
		const running = describeConverge(session);
		expect(running.status).toBe("running");
		expect(running.active).toBe(true);
		expect(running.cancellable).toBe(true);

		gated.release();
		await pending;
		const done = describeConverge(session);
		expect(done.status).toBe("converged");
		expect(done.cancellable).toBe(false);
		expect(done.iteration).toBe(1);
	});

	test("trace reads the durable loop log plus the live state", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session);
		const t = traceConverge(session);
		expect(t.loopId).toBe("L1");
		expect(t.status).toBe("open");
		expect(t.active).toBe(false);
		// The records come straight from the loop log (header + the one iteration).
		expect(t.records[0]?.type).toBe("loop");
		expect(t.records.filter((r) => r.type === "iteration").length).toBe(1);
	});

	test("describeConverge and traceConverge surface the participant provenance when carried", () => {
		const participants = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-opus-4", reasoningEffort: "high", envKeys: ["ANTHROPIC_API_KEY"] },
			},
			rev: {
				agentId: "codex",
				adapter: "codex-exec",
				session: "per_scope" as const,
				permissions: { filesystem: "read_only" as const },
				enforcesReadOnly: true,
				config: { model: "gpt-5-codex" },
			},
		};
		const session = startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 1,
			execute: scriptedExecute([reviewJson("proceed")]),
			loopId: "PROV1",
			participants,
		});
		expect(describeConverge(session).participants).toEqual(participants);
		expect(traceConverge(session).participants).toEqual(participants);
	});

	test("a session launched without provenance omits participants (no invented field)", () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		expect(describeConverge(session).participants).toBeUndefined();
		expect(traceConverge(session).participants).toBeUndefined();
	});

	// The receipt chit_trace attaches to a foreground loop is buildLoopReceipt over the SAME
	// records traceConverge returns, with the live run status. These run the REAL engine so the
	// receipt is validated against real verdict/decision/stop records, not hand-built ones.
	test("receipt over real engine records: a converged loop attributes the stop to its last round", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session); // revise -> loop stays open
		await runNextIteration(session); // proceed + passing checks -> converged
		const t = traceConverge(session);
		const receipt = buildLoopReceipt(t.records, t.status);
		expect(receipt.status).toBe("converged");
		expect(receipt.iterationsCompleted).toBe(2);
		// The converged stop is round 2's own doing (decision proceed), so it joins the line.
		expect(receipt.statusLine).toBe("iteration 2 · proceed · 1/1 checks passed · converged");
		expect(receipt.verification).toBe("passed");
		expect(receipt.verificationSource).toBe("reviewer");
		expect(receipt.stopReason).toBeDefined();
	});

	test("receipt over real engine records: a cancelled zero-iteration loop has no statusLine", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		cancelConverge(session); // no iteration ran -> a cancelled stop with iterations 0
		const t = traceConverge(session);
		const receipt = buildLoopReceipt(t.records, t.status);
		expect(receipt.status).toBe("cancelled");
		expect(receipt.iterationsCompleted).toBe(0);
		expect(receipt.statusLine).toBeUndefined();
		expect(receipt.changedFiles).toEqual([]);
		expect(receipt.stopReason).toBeDefined();
		expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
	});
});

describe("loop policy: non-default step ids (Stage 2)", () => {
	test("runNextIteration keys outputs/checkDuration on the session's policy steps", async () => {
		const review = reviewJson("proceed", { findingCount: 1, checksRun: "bun test" });
		// The run reports outputs/trace under build/check, not implement/review.
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { build: "built the slice", check: review },
			trace: [{ type: "step.completed", stepId: "check", output: review, durationMs: 777 }],
		});
		const session = startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 1,
			execute,
			loopId: "POLICY1",
			loopSteps: { implementStep: "build", reviewStep: "check" },
		});

		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error(`expected iteration, got ${r.kind}`);
		// Verdict parsed from outputs["check"], not a missing outputs["review"].
		expect(r.verdict).toBe("proceed");
		expect(r.findingCount).toBe(1);
		const it = iterations(session.loopId)[0];
		// implementSummary from outputs["build"]; checkDuration from the "check" step.
		expect(it?.implementSummary).toContain("built the slice");
		expect(it?.checkDurationMs).toBe(777);
	});
});

describe("required checks via runNextIteration (chit-executed, the MCP driver)", () => {
	const PASS: RequiredCheck = { command: "true", args: [] };
	const FAIL: RequiredCheck = { command: "false", args: [] };
	const BLOCK: RequiredCheck = { command: "sleep", args: ["5"], timeoutMs: 50 };

	const startWithChecks = (execute: ConvergeExecute, requiredChecks: RequiredCheck[]) =>
		startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			execute,
			loopId: "L1",
			loopSteps: { implementStep: "implement", reviewStep: "review", requiredChecks },
		});

	test("proceed + passing checks -> converged via chit (verificationSource chit)", async () => {
		const session = startWithChecks(scriptedExecute([reviewJson("proceed")]), [PASS]);
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBe("converged");
		const it = iterations("L1")[0];
		expect(it?.verification).toBe("passed");
		expect(it?.verificationSource).toBe("chit");
		// The session caches the latest verification + source for status views.
		expect(session.lastVerification).toBe("passed");
		expect(session.lastVerificationSource).toBe("chit");
		// ...and the structured checks too, in lockstep -- the mirror equals the durable record.
		expect(session.lastChecks).toEqual(it?.checks);
		expect(session.lastChecks?.every((c) => c.status === "passed")).toBe(true);
	});

	test("proceed + a failed check -> the iteration is a revise (no stop, decision diverges)", async () => {
		const session = startWithChecks(
			scriptedExecute([reviewJson("proceed"), reviewJson("proceed")]),
			[FAIL],
		);
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBeUndefined(); // revise -> the loop continues
		const it = iterations("L1")[0];
		expect(it?.decision).toBe("revise");
		expect(it?.verification).toBe("failed");
		expect(it?.verificationSource).toBe("chit");
	});

	test("proceed + a blocked-only check -> needs-decision", async () => {
		const session = startWithChecks(scriptedExecute([reviewJson("proceed")]), [BLOCK]);
		const r = await runNextIteration(session);
		if (r.kind !== "iteration") throw new Error("expected iteration");
		expect(r.stopStatus).toBe("needs-decision");
		expect(iterations("L1")[0]?.verification).toBe("blocked");
	});
});

describe("runNextIteration: live trace -> opts.onTrace", () => {
	test("an opts.onTrace passed to runNextIteration reaches the execute's ctx", async () => {
		const review = reviewJson("proceed");
		// A fake execute that forwards a step.started event through ctx.onTrace, the
		// same channel the real audited execute uses to surface per-step progress.
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctx?.onTrace?.({ type: "step.started", stepId: "implement", kind: "call" });
			ctx?.onTrace?.({ type: "step.started", stepId: "review", kind: "call" });
			return {
				ok: true,
				output: "",
				outputs: { implement: "x", review },
				trace: [{ type: "step.completed", stepId: "review", output: review, durationMs: 1 }],
			};
		};
		const session = start(execute);
		const seen: TraceEvent[] = [];
		const r = await runNextIteration(session, { onTrace: (e) => seen.push(e) });
		expect(r.kind).toBe("iteration");
		expect(seen.map((e) => e.type === "step.started" && e.stepId)).toEqual(["implement", "review"]);
	});
});

describe("runNextIteration: structured checks in the iteration arm", () => {
	test("checks is [] when no checks ran and populated when the reviewer reports them", async () => {
		// No checks reported -> the iteration arm carries an empty array.
		const none = start(scriptedExecute([reviewJson("revise", { checks: [] })]));
		const r0 = await runNextIteration(none);
		if (r0.kind !== "iteration") throw new Error("expected iteration");
		expect(r0.checks).toEqual([]);

		// Reviewer-reported checks flow through to the iteration arm with names/statuses.
		const withChecks = startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			execute: scriptedExecute([
				reviewJson("revise", { checks: [{ command: "bun test", status: "passed" }] }),
			]),
			loopId: "L2",
		});
		const r1 = await runNextIteration(withChecks);
		if (r1.kind !== "iteration") throw new Error("expected iteration");
		expect(r1.checks).toEqual([{ command: "bun test", status: "passed" }]);
	});
});

describe("runNextIteration: endedAtMs mirrors terminalStatus", () => {
	test("set on converged", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("converged");
		expect(typeof session.endedAtMs).toBe("number");
	});

	test("set on a blocked verdict", async () => {
		const session = start(scriptedExecute([reviewJson("block")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("blocked");
		expect(typeof session.endedAtMs).toBe("number");
	});

	test("set on max-iterations", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("revise")]), 2);
		await runNextIteration(session);
		expect(session.endedAtMs).toBeUndefined(); // still open after the first revise
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("max-iterations");
		expect(typeof session.endedAtMs).toBe("number");
	});

	test("set on cancelled", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		const controller = new AbortController();
		controller.abort();
		await runNextIteration(session, { signal: controller.signal });
		expect(session.terminalStatus).toBe("cancelled");
		expect(typeof session.endedAtMs).toBe("number");
	});

	test("absent while the loop is still open", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBeUndefined();
		expect(session.endedAtMs).toBeUndefined();
	});
});

describe("runNextIteration: stopReason mirrors terminalStatus", () => {
	// The in-memory stopReason is the mirror of the durable stop record's reason, set
	// in lockstep with terminalStatus -- so a terminal run's view can report WHY it
	// stopped without re-reading the loop log. Each case asserts the mirror equals the
	// reason actually written to the log.
	test("set on converged, matching the durable stop record", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("converged");
		expect(session.stopReason).toBe("reviewer returned proceed and verification passed");
		expect(session.stopReason).toBe(stopRecord("L1")?.reason);
	});

	test("set on a blocked verdict, matching the durable stop record", async () => {
		const session = start(scriptedExecute([reviewJson("block")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("blocked");
		expect(session.stopReason).toBe("reviewer returned block");
		expect(session.stopReason).toBe(stopRecord("L1")?.reason);
	});

	test("set on max-iterations, matching the durable stop record", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("revise")]), 2);
		await runNextIteration(session);
		expect(session.stopReason).toBeUndefined(); // still open after the first revise
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("max-iterations");
		expect(session.stopReason).toBe("reached max iterations (2) without converging");
		expect(session.stopReason).toBe(stopRecord("L1")?.reason);
	});

	test("set on cancelled, matching the durable stop record", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		const controller = new AbortController();
		controller.abort();
		await runNextIteration(session, { signal: controller.signal });
		expect(session.terminalStatus).toBe("cancelled");
		expect(session.stopReason).toBe("cancelled via MCP (client abort or chit_cancel)");
		expect(session.stopReason).toBe(stopRecord("L1")?.reason);
	});

	test("absent while the loop is still open", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBeUndefined();
		expect(session.stopReason).toBeUndefined();
	});
});

describe("runNextIteration: lastChecks mirrors the completed iteration", () => {
	// The session caches the last round's structured checks alongside the other last*
	// fields (set in lockstep on a completed iteration), so a status view can recompose
	// the chit_next check rollup without re-reading the loop log. Each case ties the
	// mirror to the durable iteration record, the source of truth.
	test("set from the reviewer's reported checks, in lockstep with lastVerdict", async () => {
		const session = start(
			scriptedExecute([
				reviewJson("revise", { checks: [{ command: "bun test", status: "passed" }] }),
			]),
		);
		await runNextIteration(session);
		// Both advance together on the completed round...
		expect(session.lastVerdict).toBe("revise");
		expect(session.lastChecks).toEqual([{ command: "bun test", status: "passed" }]);
		// ...and the mirror is faithful to the durable record.
		expect(session.lastChecks).toEqual(iterations("L1")[0]?.checks);
	});

	test("set to [] when the completed round ran no checks", async () => {
		const session = start(scriptedExecute([reviewJson("revise", { checks: [] })]));
		await runNextIteration(session);
		expect(session.lastChecks).toEqual([]);
	});

	test("absent until a round completes; a cancelled-first round leaves it unset", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		expect(session.lastChecks).toBeUndefined(); // fresh: nothing has completed
		const controller = new AbortController();
		controller.abort();
		await runNextIteration(session, { signal: controller.signal });
		// Cancelled with no iteration record appended -> the mirror never advanced.
		expect(session.terminalStatus).toBe("cancelled");
		expect(session.lastChecks).toBeUndefined();
	});
});

describe("runNextIteration: lastStopStatus is the completed round's OWN stop", () => {
	// terminalStatus can be set by a LATER cancelled/failed attempt that completed no
	// round; lastStopStatus advances only with the completed-iteration mirror, so a
	// status view can attribute a stop clause to the right round (never borrow a later
	// round's stop for an earlier round's line).
	test("set on a converging round, in lockstep with terminalStatus", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("converged");
		expect(session.lastStopStatus).toBe("converged");
	});

	test("a continuing revise leaves it unset (the round produced no stop)", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session);
		expect(session.terminalStatus).toBeUndefined();
		expect(session.lastStopStatus).toBeUndefined();
	});

	test("a budget-exhausting revise records max-iterations as its own stop", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("revise")]), 2);
		await runNextIteration(session);
		await runNextIteration(session);
		expect(session.terminalStatus).toBe("max-iterations");
		expect(session.lastStopStatus).toBe("max-iterations");
	});

	test("a later cancelled attempt sets terminalStatus but never advances this mirror", async () => {
		const session = start(scriptedExecute([reviewJson("revise"), reviewJson("proceed")]));
		await runNextIteration(session); // round 1 completes: revise, the loop stays open
		expect(session.lastVerdict).toBe("revise");
		expect(session.lastStopStatus).toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		await runNextIteration(session, { signal: controller.signal }); // round 2: cancelled, no record
		expect(session.terminalStatus).toBe("cancelled");
		// The completed-round mirror did not advance: verdict still round 1's, stop still none --
		// the exact state whose status line must not read "... · cancelled".
		expect(session.lastVerdict).toBe("revise");
		expect(session.lastStopStatus).toBeUndefined();
	});
});

describe("runNextIteration: in-flight activity snapshot", () => {
	// The session records a live activity snapshot WHILE an iteration runs, fed by the same
	// onTrace / onChecksStart the heartbeat reads, and CLEARS it on settle -- so a concurrent
	// chit_status can answer "is it stuck?" from returned data, and a stopped run never
	// reports a stale phase. These pin the lockstep recording (the view derives the ages).
	test("opens the snapshot while an iteration runs and clears it on settle", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		expect(session.activity).toBeUndefined(); // nothing running yet

		const pending = runNextIteration(session);
		await gated.onStarted;
		// In flight: the snapshot names the iteration now running. phase is still unknown in
		// the spin-up before the first step start reaches onTrace.
		expect(session.activity?.iteration).toBe(1);
		expect(typeof session.activity?.lastActivityAtMs).toBe("number");

		gated.release();
		await pending;
		expect(session.terminalStatus).toBe("converged");
		expect(session.activity).toBeUndefined(); // cleared on settle, in lockstep with `active`
	});

	test("advances the phase as the implement then review steps start", async () => {
		// The engine marks the phase from each step.started BEFORE forwarding to the caller's
		// onTrace, so the snapshot already reflects the step when the caller observes its start.
		const phases: (LoopPhase | undefined)[] = [];
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctx?.onTrace?.({ type: "step.started", stepId: "implement", kind: "call" });
			ctx?.onTrace?.({ type: "step.started", stepId: "review", kind: "call" });
			return {
				ok: true,
				output: "",
				outputs: { implement: "x", review: reviewJson("proceed") },
				trace: [
					{
						type: "step.completed",
						stepId: "review",
						output: reviewJson("proceed"),
						durationMs: 1,
					},
				],
			};
		};
		const session = start(execute);
		await runNextIteration(session, {
			onTrace: (e) => {
				if (e.type === "step.started") phases.push(session.activity?.phase);
			},
		});
		expect(phases).toEqual(["implementing", "reviewing"]);
	});

	test("marks 'running required checks' when chit runs the checks", async () => {
		// onChecksStart fires only on reviewer proceed + declared checks; the engine marks the
		// phase before forwarding, so the snapshot reads it when the caller is notified.
		const PASS: RequiredCheck = { command: "true", args: [] };
		const session = startConvergeSession({
			cwd,
			scope: "s",
			task: "t",
			maxIterations: 3,
			execute: scriptedExecute([reviewJson("proceed")]),
			loopId: "L1",
			loopSteps: { implementStep: "implement", reviewStep: "review", requiredChecks: [PASS] },
		});
		let phaseAtChecks: LoopPhase | undefined;
		await runNextIteration(session, {
			onChecksStart: () => {
				phaseAtChecks = session.activity?.phase;
			},
		});
		expect(phaseAtChecks).toBe("running required checks");
	});

	test("cancelConverge marks the in-flight snapshot 'cancelling', then settle clears it", async () => {
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		const pending = runNextIteration(session);
		await gated.onStarted;
		expect(session.activity).toBeDefined();

		expect(cancelConverge(session).state).toBe("cancelling");
		// Visible in the brief window before the aborted iteration settles -- the value of
		// recording it: chit_cancel's view (and a concurrent chit_status) sees "cancelling".
		expect(session.activity?.phase).toBe("cancelling");

		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(session.activity).toBeUndefined(); // cleared on settle
	});

	test("an external request-signal abort (Esc) marks 'cancelling' too, not only chit_cancel", async () => {
		// A foreground chit_next cancelled via the MCP request signal / Esc aborts the
		// controller directly (cancelConverge is never called), so the shared abort path must
		// mark "cancelling" -- else chit_status would still report the prior phase.
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		const controller = new AbortController();
		const pending = runNextIteration(session, { signal: controller.signal });
		await gated.onStarted;
		expect(session.activity?.phase).toBeUndefined(); // parked pre-trace: no phase yet

		controller.abort(); // Esc / request abort, NOT chit_cancel
		expect(session.activity?.phase).toBe("cancelling");

		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(session.activity).toBeUndefined(); // cleared on settle
	});

	test("a signal already aborted at call time marks 'cancelling' before the iteration settles", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		const controller = new AbortController();
		controller.abort();
		const pending = runNextIteration(session, { signal: controller.signal });
		// The fold-in ran synchronously (before the first await) and marked the snapshot, so a
		// concurrent chit_status in this window sees the cancel rather than a spin-up phase.
		expect(session.activity?.phase).toBe("cancelling");

		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(session.activity).toBeUndefined();
	});
});

describe("runNextIteration: onActivityChange observer (registry mirror hook)", () => {
	// The engine fires onActivityChange whenever `activity` changes, so the server can
	// mirror live foreground activity to the cross-process registry without the engine
	// owning any persistence. It must fire on iteration start, each phase transition, and
	// on settle (when activity is cleared), and a throwing observer must never break the loop.
	test("fires on start, each phase transition, and on settle (cleared)", async () => {
		const observed: (LoopPhase | "starting" | "settled")[] = [];
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctx?.onTrace?.({ type: "step.started", stepId: "implement", kind: "call" });
			ctx?.onTrace?.({ type: "step.started", stepId: "review", kind: "call" });
			return {
				ok: true,
				output: "",
				outputs: { implement: "x", review: reviewJson("proceed") },
				trace: [
					{
						type: "step.completed",
						stepId: "review",
						output: reviewJson("proceed"),
						durationMs: 1,
					},
				],
			};
		};
		const session = start(execute);
		session.onActivityChange = (s) =>
			observed.push(s.activity ? (s.activity.phase ?? "starting") : "settled");
		await runNextIteration(session);
		// start (no phase yet -> "starting"), implementing, reviewing, then settle clears it.
		expect(observed[0]).toBe("starting");
		expect(observed).toContain("implementing");
		expect(observed).toContain("reviewing");
		expect(observed.at(-1)).toBe("settled"); // the final fire is the settle (activity cleared)
	});

	test("fires 'cancelling' then 'settled' when an in-flight iteration is cancelled", async () => {
		const observed: (LoopPhase | "starting" | "settled")[] = [];
		const gated = gatedExecute(reviewJson("proceed"));
		const session = start(gated.execute);
		session.onActivityChange = (s) =>
			observed.push(s.activity ? (s.activity.phase ?? "starting") : "settled");
		const pending = runNextIteration(session);
		await gated.onStarted;
		cancelConverge(session);
		const r = await pending;
		expect(r.kind).toBe("cancelled");
		expect(observed).toContain("cancelling");
		expect(observed.at(-1)).toBe("settled");
	});

	test("a throwing observer never breaks the iteration", async () => {
		const session = start(scriptedExecute([reviewJson("proceed")]));
		session.onActivityChange = () => {
			throw new Error("registry write blew up");
		};
		const r = await runNextIteration(session);
		expect(r.kind).toBe("iteration"); // the loop converged despite the observer throwing
		expect(session.terminalStatus).toBe("converged");
	});
});
