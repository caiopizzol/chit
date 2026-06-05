import { describe, expect, test } from "bun:test";
import type {
	LoopCheck,
	LoopIterationRecord,
	LoopRecord,
	LoopStopStatus,
	LoopVerdict,
	VerificationSource,
} from "@chit-run/core";
import { loopStatusLine } from "./loopStatus.ts";

function header(): LoopRecord {
	return {
		type: "loop",
		schema: 1,
		loopId: "loop-1",
		scope: "src",
		task: "do the thing",
		repo: "/repo",
		repoKey: "key",
		startedAt: "2026-01-01T00:00:00.000Z",
		maxIterations: 3,
	};
}

function iter(
	n: number,
	verdict: LoopVerdict,
	opts: {
		checks?: LoopCheck[];
		verificationSource?: VerificationSource;
		decision?: LoopVerdict;
	} = {},
): LoopIterationRecord {
	return {
		type: "iteration",
		n,
		implementSummary: `round ${n}`,
		changedFiles: [],
		checksRun: "ran checks",
		verdict,
		findingCount: 0,
		decision: opts.decision ?? verdict,
		checkDurationMs: 1000,
		at: "2026-01-01T00:01:00.000Z",
		...(opts.checks !== undefined && { checks: opts.checks }),
		...(opts.verificationSource !== undefined && { verificationSource: opts.verificationSource }),
	};
}

function stop(status: LoopStopStatus, iterations: number): LoopRecord {
	return {
		type: "stop",
		status,
		reason: "because",
		iterations,
		totalElapsedMs: 5000,
		endedAt: "2026-01-01T00:05:00.000Z",
	};
}

const PASS: LoopCheck[] = [
	{ command: "bun test", status: "passed" },
	{ command: "bun run check", status: "passed" },
];
const MIXED: LoopCheck[] = [
	{ command: "bun test", status: "passed" },
	{ command: "bun run check", status: "failed" },
];

describe("loopStatusLine", () => {
	test("no completed iteration -> undefined (open loop invents nothing)", () => {
		expect(loopStatusLine([header()])).toBeUndefined();
	});

	test("summarizes the last completed round of an in-progress loop", () => {
		const records = [header(), iter(1, "proceed", { checks: PASS, verificationSource: "chit" })];
		expect(loopStatusLine(records)).toBe("iteration 1 · proceed · 2/2 required checks passed");
	});

	test("reviewer-sourced checks use the advisory noun", () => {
		const records = [
			header(),
			iter(1, "proceed", { checks: PASS, verificationSource: "reviewer" }),
		];
		expect(loopStatusLine(records)).toBe("iteration 1 · proceed · 2/2 checks passed");
	});

	test("absent verification source falls back to the advisory noun", () => {
		const records = [header(), iter(1, "revise", { checks: MIXED })];
		expect(loopStatusLine(records)).toBe("iteration 1 · revise · 1/2 checks passed");
	});

	test("omits the checks segment when the round recorded none", () => {
		const records = [header(), iter(1, "proceed")];
		expect(loopStatusLine(records)).toBe("iteration 1 · proceed");
	});

	test("converged stop is attributed to the last round", () => {
		const records = [
			header(),
			iter(1, "proceed", { checks: PASS, verificationSource: "chit" }),
			stop("converged", 1),
		];
		expect(loopStatusLine(records)).toBe(
			"iteration 1 · proceed · 2/2 required checks passed · converged",
		);
	});

	test("needs-decision stop is attributed to the last round", () => {
		const records = [
			header(),
			iter(1, "proceed", { checks: MIXED, verificationSource: "chit" }),
			stop("needs-decision", 1),
		];
		expect(loopStatusLine(records)).toBe(
			"iteration 1 · proceed · 1/2 required checks passed · needs-decision",
		);
	});

	test("max-iterations stop is attributed to a final revise round", () => {
		const records = [
			header(),
			iter(1, "revise"),
			iter(2, "revise"),
			iter(3, "revise"),
			stop("max-iterations", 3),
		];
		expect(loopStatusLine(records)).toBe("iteration 3 · revise · max-iterations");
	});

	test("blocked stop is attributed when the last verdict is block", () => {
		const records = [header(), iter(1, "block"), stop("blocked", 1)];
		expect(loopStatusLine(records)).toBe("iteration 1 · block · blocked");
	});

	// A cancel between rounds, or an implement failure that recorded no iteration, must
	// NOT graft its stop onto the earlier completed round -- the CLI's lastStopStatus
	// mirror stays at that round's own (absent) stop.
	test("cancelled stop is never attributed to the last completed round", () => {
		const records = [
			header(),
			iter(1, "proceed", { checks: PASS, verificationSource: "chit" }),
			stop("cancelled", 1),
		];
		expect(loopStatusLine(records)).toBe("iteration 1 · proceed · 2/2 required checks passed");
	});

	test("blocked stop is NOT attributed when the last completed verdict is not block", () => {
		// e.g. iteration 1 proceeded, then a later implement step failed and the loop
		// stopped blocked without recording a round -- the line stays iteration 1's.
		const records = [
			header(),
			iter(1, "proceed", { checks: PASS, verificationSource: "chit" }),
			stop("blocked", 1),
		];
		expect(loopStatusLine(records)).toBe("iteration 1 · proceed · 2/2 required checks passed");
	});
});
