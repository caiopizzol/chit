import { describe, expect, test } from "bun:test";
import type {
	LoopCheck,
	LoopHeaderRecord,
	LoopIterationRecord,
	LoopStopRecord,
	LoopVerdict,
} from "./log.ts";
import { buildLoopReceipt, composeLoopStatusLine } from "./status-line.ts";

const PASS: LoopCheck[] = [
	{ command: "bun test", status: "passed" },
	{ command: "bun run check", status: "passed" },
];
const MIXED: LoopCheck[] = [
	{ command: "bun test", status: "passed" },
	{ command: "bun run check", status: "failed" },
];

describe("composeLoopStatusLine", () => {
	test("full line: iteration · verdict · chit-sourced required-check rollup · stop", () => {
		expect(
			composeLoopStatusLine({
				iteration: 2,
				outcome: "proceed",
				checks: PASS,
				source: "chit",
				stop: "converged",
			}),
		).toBe("iteration 2 · proceed · 2/2 required checks passed · converged");
	});

	test("reviewer-sourced checks use the advisory noun", () => {
		expect(
			composeLoopStatusLine({
				iteration: 1,
				outcome: "proceed",
				checks: PASS,
				source: "reviewer",
				stop: undefined,
			}),
		).toBe("iteration 1 · proceed · 2/2 checks passed");
	});

	test("an absent verification source falls back to the advisory noun", () => {
		expect(
			composeLoopStatusLine({
				iteration: 1,
				outcome: "revise",
				checks: MIXED,
				source: undefined,
				stop: undefined,
			}),
		).toBe("iteration 1 · revise · 1/2 checks passed");
	});

	test("omits the checks segment when the round ran none", () => {
		// undefined checks (a cancelled/failed round) and an empty array (an iteration
		// that ran no checks) both drop the segment.
		expect(
			composeLoopStatusLine({
				iteration: 1,
				outcome: "revise",
				checks: undefined,
				source: undefined,
				stop: undefined,
			}),
		).toBe("iteration 1 · revise");
		expect(
			composeLoopStatusLine({
				iteration: 1,
				outcome: "revise",
				checks: [],
				source: "chit",
				stop: undefined,
			}),
		).toBe("iteration 1 · revise");
	});

	test("omits the stop segment when no stop is attributed (the round did not stop)", () => {
		expect(
			composeLoopStatusLine({
				iteration: 1,
				outcome: "revise",
				checks: MIXED,
				source: "chit",
				stop: undefined,
			}),
		).toBe("iteration 1 · revise · 1/2 required checks passed");
	});

	test("drops the stop word when it would merely restate the outcome", () => {
		// A cancelled iteration: chit_next sets outcome = result.kind = "cancelled" and
		// session.terminalStatus = "cancelled", so the stop must not be repeated.
		expect(
			composeLoopStatusLine({
				iteration: 3,
				outcome: "cancelled",
				checks: undefined,
				source: undefined,
				stop: "cancelled",
			}),
		).toBe("iteration 3 · cancelled");
	});
});

const HEADER: LoopHeaderRecord = {
	type: "loop",
	schema: 1,
	loopId: "loop-1",
	scope: "src",
	task: "do the thing",
	repo: "/repo",
	repoKey: "abc123",
	startedAt: "2026-06-07T00:00:00.000Z",
	maxIterations: 3,
};

function iteration(n: number, over: Partial<LoopIterationRecord> = {}): LoopIterationRecord {
	const verdict: LoopVerdict = over.verdict ?? "revise";
	return {
		type: "iteration",
		n,
		implementSummary: `iteration ${n}`,
		changedFiles: [],
		checksRun: "none",
		verdict,
		findingCount: 0,
		decision: over.decision ?? verdict,
		checkDurationMs: 0,
		at: `2026-06-07T00:0${n}:00.000Z`,
		...over,
	};
}

function stop(over: Partial<LoopStopRecord> = {}): LoopStopRecord {
	return {
		type: "stop",
		status: "converged",
		reason: "converged",
		iterations: 0,
		totalElapsedMs: 0,
		endedAt: "2026-06-07T00:10:00.000Z",
		...over,
	};
}

const PASS_CHECKS: LoopCheck[] = [
	{ command: "bun test", status: "passed" },
	{ command: "bun run check", status: "passed" },
];

describe("buildLoopReceipt", () => {
	test("aggregates changedFiles, workspaceWarnings, auditRefs, and usage across iterations", () => {
		const records = [
			HEADER,
			iteration(1, {
				changedFiles: ["a.ts", "b.ts"],
				workspaceWarnings: ["w1"],
				auditRef: "aud-1",
				usage: { inputTokens: 10, outputTokens: 5 },
			}),
			iteration(2, {
				// b.ts repeats (deduped), c.ts is new; w1 repeats, w2 is new.
				changedFiles: ["b.ts", "c.ts"],
				workspaceWarnings: ["w1", "w2"],
				auditRef: "aud-2",
				usage: { inputTokens: 20, totalTokens: 7 },
			}),
		];
		const receipt = buildLoopReceipt(records);
		// First-seen order, de-duplicated unions.
		expect(receipt.changedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(receipt.workspaceWarnings).toEqual(["w1", "w2"]);
		expect(receipt.auditRefs).toEqual(["aud-1", "aud-2"]);
		// Per-field additive usage; a field absent from a call stays absent (not 0).
		expect(receipt.usage).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 7 });
		// No stop record: open, and the count is the iteration records present.
		expect(receipt.status).toBe("open");
		expect(receipt.iterationsCompleted).toBe(2);
	});

	test("omits usage entirely when no iteration reported any", () => {
		const receipt = buildLoopReceipt([HEADER, iteration(1)]);
		expect(receipt.usage).toBeUndefined();
		// changedFiles / workspaceWarnings / auditRefs are always arrays (empty here).
		expect(receipt.changedFiles).toEqual([]);
		expect(receipt.workspaceWarnings).toEqual([]);
		expect(receipt.auditRefs).toEqual([]);
	});

	test("builds the latest iteration's statusLine and appends a stop that corresponds to it", () => {
		// A proceed-decision iteration whose chit-run checks passed -> the converged stop is
		// THIS round's own, so it is appended to the line.
		const records = [
			HEADER,
			iteration(1, { verdict: "revise", decision: "revise" }),
			iteration(2, {
				verdict: "proceed",
				decision: "proceed",
				verification: "passed",
				verificationSource: "chit",
				checks: PASS_CHECKS,
			}),
			stop({ status: "converged", reason: "all checks passed", iterations: 2 }),
		];
		const receipt = buildLoopReceipt(records);
		expect(receipt.statusLine).toBe(
			"iteration 2 · proceed · 2/2 required checks passed · converged",
		);
		expect(receipt.status).toBe("converged");
		expect(receipt.iterationsCompleted).toBe(2);
		expect(receipt.latestChecks).toEqual(PASS_CHECKS);
		expect(receipt.verification).toBe("passed");
		expect(receipt.verificationSource).toBe("chit");
		expect(receipt.stopReason).toBe("all checks passed");
	});

	test("appends a needs-decision stop when a proceed round did not verify", () => {
		const records = [
			HEADER,
			iteration(1, {
				verdict: "proceed",
				decision: "proceed",
				verification: "blocked",
				verificationSource: "chit",
				checks: [
					{
						command: "bun test",
						status: "blocked",
						reason: "sandbox could not create a temp dir",
					},
				],
			}),
			stop({
				status: "needs-decision",
				reason: "verification did not pass",
				iterations: 1,
			}),
		];
		const receipt = buildLoopReceipt(records);
		expect(receipt.statusLine).toBe(
			"iteration 1 · proceed · 0/1 required checks passed · needs-decision",
		);
		expect(receipt.status).toBe("needs-decision");
	});

	test("does NOT append a cancelled stop to the latest completed iteration's line", () => {
		// The loop completed iteration 1 (revise), then a later in-flight round was cancelled
		// and wrote NO record. The cancelled stop is not iteration 1's doing, so it is omitted.
		const records = [
			HEADER,
			iteration(1, { verdict: "revise", decision: "revise" }),
			stop({ status: "cancelled", reason: "cancelled via chit_cancel", iterations: 1 }),
		];
		const receipt = buildLoopReceipt(records);
		expect(receipt.statusLine).toBe("iteration 1 · revise");
		expect(receipt.status).toBe("cancelled");
	});

	test("does NOT append a manifest-failure blocked stop on a non-block latest decision", () => {
		// A blocked stop whose latest recorded round did not itself block (decision revise) is a
		// later manifest failure that wrote no record -- it must not be attributed to this line.
		const records = [
			HEADER,
			iteration(1, { verdict: "proceed", decision: "revise", verification: "failed" }),
			stop({ status: "blocked", reason: "manifest run threw", iterations: 1 }),
		];
		const receipt = buildLoopReceipt(records);
		expect(receipt.statusLine).toBe("iteration 1 · proceed");
		expect(receipt.status).toBe("blocked");
	});

	test("appends a blocked stop when the latest iteration itself blocked", () => {
		const records = [
			HEADER,
			iteration(1, { verdict: "block", decision: "block" }),
			stop({ status: "blocked", reason: "reviewer blocked", iterations: 1 }),
		];
		const receipt = buildLoopReceipt(records);
		// outcome "block" plus the distinct "blocked" stop word.
		expect(receipt.statusLine).toBe("iteration 1 · block · blocked");
	});

	test("stopped-zero-iteration loop: no statusLine, but stopReason and elapsedMs are present", () => {
		const records = [
			HEADER,
			stop({
				status: "cancelled",
				reason: "cancelled via chit_cancel (no iteration running)",
				iterations: 0,
				totalElapsedMs: 1234,
				endedAt: "2026-06-07T00:00:05.000Z",
			}),
		];
		const receipt = buildLoopReceipt(records);
		expect(receipt.statusLine).toBeUndefined();
		expect(receipt.status).toBe("cancelled");
		expect(receipt.iterationsCompleted).toBe(0);
		expect(receipt.changedFiles).toEqual([]);
		expect(receipt.workspaceWarnings).toEqual([]);
		expect(receipt.auditRefs).toEqual([]);
		expect(receipt.usage).toBeUndefined();
		expect(receipt.stopReason).toBe("cancelled via chit_cancel (no iteration running)");
		expect(receipt.elapsedMs).toBe(1234);
		expect(receipt.endedAt).toBe("2026-06-07T00:00:05.000Z");
	});

	test("a passed live status fills status only while the log has no stop; a stop record wins", () => {
		// In-flight: no stop record, so the caller's live "running" surfaces.
		const running = buildLoopReceipt([HEADER, iteration(1)], "running");
		expect(running.status).toBe("running");
		// Settled: the stop record is authoritative even if a stale "running" is passed.
		const settled = buildLoopReceipt(
			[
				HEADER,
				iteration(1, { verdict: "block", decision: "block" }),
				stop({ status: "blocked", reason: "blocked", iterations: 1 }),
			],
			"running",
		);
		expect(settled.status).toBe("blocked");
	});
});
