import { describe, expect, test } from "bun:test";
import type { LoopCheck } from "./log.ts";
import { composeLoopStatusLine } from "./status-line.ts";

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
