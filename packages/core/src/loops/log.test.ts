import { describe, expect, test } from "bun:test";
import {
	type LoopHeaderRecord,
	type LoopIterationRecord,
	LoopLogError,
	type LoopStopRecord,
	parseLoopLog,
	serializeLoopRecord,
	validateLoopLog,
	validateLoopRecord,
} from "./log.ts";

const header: LoopHeaderRecord = {
	type: "loop",
	schema: 1,
	loopId: "L1",
	scope: "studio-loop-viz",
	task: "add convergence log writer",
	repo: "/abs/chit",
	repoKey: "3f9a2b7c1d4e5a6b",
	startedAt: "2026-05-29T10:00:00.000Z",
	maxIterations: 3,
};

const iteration: LoopIterationRecord = {
	type: "iteration",
	n: 1,
	implementSummary: "add convergence log writer",
	changedFiles: ["packages/core/src/loops/log.ts", "packages/core/src/loops/log.test.ts"],
	checksRun: "core tests + typecheck",
	verdict: "revise",
	findingCount: 2,
	decision: "revise",
	checkDurationMs: 18000,
	at: "2026-05-29T10:01:00.000Z",
};

const stop: LoopStopRecord = {
	type: "stop",
	status: "converged",
	reason: "proceed + task complete",
	iterations: 2,
	totalElapsedMs: 192000,
	endedAt: "2026-05-29T10:03:12.000Z",
};

describe("convergence log: serialize/validate round-trip", () => {
	test("each record kind round-trips through serialize -> parse", () => {
		const body = [header, iteration, stop].map(serializeLoopRecord).join("\n");
		expect(parseLoopLog(body)).toEqual([header, iteration, stop]);
	});

	test("a trailing newline and blank lines are skipped", () => {
		const body = `${serializeLoopRecord(header)}\n\n${serializeLoopRecord(stop)}\n`;
		expect(parseLoopLog(body)).toEqual([header, stop]);
	});

	test("optional auditRef survives the round-trip", () => {
		const withRef: LoopIterationRecord = { ...iteration, auditRef: "run:abc123" };
		expect(validateLoopRecord(JSON.parse(serializeLoopRecord(withRef)))).toEqual(withRef);
	});

	test("an absent auditRef is omitted, not set to undefined", () => {
		const rec = validateLoopRecord(JSON.parse(serializeLoopRecord(iteration)));
		expect("auditRef" in rec).toBe(false);
	});

	test("optional usage survives the round-trip (full and partial)", () => {
		const full: LoopIterationRecord = {
			...iteration,
			usage: {
				inputTokens: 1200,
				outputTokens: 340,
				cachedInputTokens: 800,
				reasoningTokens: 64,
				estimatedCostUsd: 0.0123,
			},
		};
		expect(validateLoopRecord(JSON.parse(serializeLoopRecord(full)))).toEqual(full);
		// Partial: a Codex-only iteration has tokens but no cost.
		const partial: LoopIterationRecord = {
			...iteration,
			usage: { inputTokens: 10, outputTokens: 2 },
		};
		expect(validateLoopRecord(JSON.parse(serializeLoopRecord(partial)))).toEqual(partial);
	});

	test("an absent usage is omitted, not set to undefined", () => {
		const rec = validateLoopRecord(JSON.parse(serializeLoopRecord(iteration)));
		expect("usage" in rec).toBe(false);
	});

	test("the required repoKey on the header survives the round-trip", () => {
		expect(validateLoopRecord(JSON.parse(serializeLoopRecord(header)))).toEqual(header);
	});

	test("rejects a header missing the required repoKey", () => {
		const { repoKey, ...noKey } = header;
		void repoKey;
		expect(() => validateLoopRecord(noKey)).toThrow(/repoKey/);
	});

	test("optional workspaceWarnings survives the round-trip", () => {
		const withWarn: LoopIterationRecord = {
			...iteration,
			workspaceWarnings: ["untracked generated artifact: __pycache__/calc.cpython-314.pyc"],
		};
		expect(validateLoopRecord(JSON.parse(serializeLoopRecord(withWarn)))).toEqual(withWarn);
	});

	test("an absent workspaceWarnings is omitted, not set to undefined", () => {
		const rec = validateLoopRecord(JSON.parse(serializeLoopRecord(iteration)));
		expect("workspaceWarnings" in rec).toBe(false);
	});
});

describe("convergence log: validation", () => {
	test("rejects an unknown record type", () => {
		expect(() => validateLoopRecord({ type: "bogus" })).toThrow(LoopLogError);
	});

	test("rejects a bad verdict enum", () => {
		expect(() => validateLoopRecord({ ...iteration, verdict: "maybe" })).toThrow(/verdict/);
	});

	test("rejects a bad stop status", () => {
		expect(() => validateLoopRecord({ ...stop, status: "done" })).toThrow(/status/);
	});

	test("rejects a missing required field", () => {
		const { task: _drop, ...missing } = header;
		expect(() => validateLoopRecord(missing)).toThrow(/task/);
	});

	test("rejects a wrong schema version on the header", () => {
		expect(() => validateLoopRecord({ ...header, schema: 2 })).toThrow(/schema/);
	});

	test("rejects workspaceWarnings that is not a string array", () => {
		expect(() => validateLoopRecord({ ...iteration, workspaceWarnings: [1] })).toThrow(
			/workspaceWarnings/,
		);
	});

	test("rejects an empty repoKey on the header", () => {
		expect(() => validateLoopRecord({ ...header, repoKey: "" })).toThrow(/repoKey/);
	});

	test("rejects changedFiles that is not a string array", () => {
		expect(() => validateLoopRecord({ ...iteration, changedFiles: [1, 2] })).toThrow(
			/changedFiles/,
		);
	});

	test("serializeLoopRecord refuses to emit an invalid record", () => {
		expect(() => serializeLoopRecord({ ...stop, status: "nope" } as never)).toThrow(LoopLogError);
	});

	test("rejects negative, fractional, or below-minimum numbers", () => {
		expect(() => validateLoopRecord({ ...iteration, n: -1 })).toThrow(/"n"/);
		expect(() => validateLoopRecord({ ...iteration, n: 0 })).toThrow(/"n"/); // 1-based
		expect(() => validateLoopRecord({ ...iteration, findingCount: 0.5 })).toThrow(/findingCount/);
		expect(() => validateLoopRecord({ ...iteration, checkDurationMs: -10 })).toThrow(
			/checkDurationMs/,
		);
		expect(() => validateLoopRecord({ ...header, maxIterations: 0 })).toThrow(/maxIterations/);
	});

	test("accepts a zero findingCount (a clean check)", () => {
		expect(validateLoopRecord({ ...iteration, findingCount: 0 })).toMatchObject({
			findingCount: 0,
		});
	});

	test("rejects invalid usage (negative/fractional token, bad cost, empty block)", () => {
		expect(() => validateLoopRecord({ ...iteration, usage: { inputTokens: -1 } })).toThrow(
			/inputTokens/,
		);
		expect(() => validateLoopRecord({ ...iteration, usage: { outputTokens: 1.5 } })).toThrow(
			/outputTokens/,
		);
		expect(() => validateLoopRecord({ ...iteration, usage: { estimatedCostUsd: -0.01 } })).toThrow(
			/estimatedCostUsd/,
		);
		expect(() =>
			validateLoopRecord({ ...iteration, usage: { estimatedCostUsd: Number.POSITIVE_INFINITY } }),
		).toThrow(/estimatedCostUsd/);
		expect(() => validateLoopRecord({ ...iteration, usage: {} })).toThrow(/at least one/);
	});

	test("accepts a fractional cost in usage (cost is not an integer)", () => {
		expect(validateLoopRecord({ ...iteration, usage: { estimatedCostUsd: 0.0042 } })).toMatchObject(
			{ usage: { estimatedCostUsd: 0.0042 } },
		);
	});
});

describe("convergence log: structural validation (validateLoopLog)", () => {
	test("accepts a complete log: loop -> iterations -> stop", () => {
		const stopOne: LoopStopRecord = { ...stop, iterations: 1 }; // matches the one iteration
		expect(validateLoopLog([header, iteration, stopOne])).toEqual([header, iteration, stopOne]);
	});

	test("rejects non-sequential iteration numbers", () => {
		const it3: LoopIterationRecord = { ...iteration, n: 3 };
		expect(() => validateLoopLog([header, iteration, it3])).toThrow(/sequential/);
	});

	test("rejects a stop whose iterations count contradicts the records", () => {
		const stopWrong: LoopStopRecord = { ...stop, iterations: 5 };
		expect(() => validateLoopLog([header, iteration, stopWrong])).toThrow(/stop\.iterations/);
	});

	test("accepts an in-progress log with no stop yet", () => {
		expect(validateLoopLog([header, iteration])).toEqual([header, iteration]);
	});

	test("rejects an empty log", () => {
		expect(() => validateLoopLog([])).toThrow(/empty/);
	});

	test("rejects a log that does not start with the loop header", () => {
		expect(() => validateLoopLog([iteration, stop])).toThrow(/first record must be a loop header/);
	});

	test("rejects a second loop header", () => {
		expect(() => validateLoopLog([header, header])).toThrow(/second loop header/);
	});

	test("rejects more than one stop record", () => {
		expect(() => validateLoopLog([header, stop, stop])).toThrow(/more than one stop/);
	});

	test("rejects a stop that is not last", () => {
		expect(() => validateLoopLog([header, stop, iteration])).toThrow(/stop record must be last/);
	});

	test("rejects a non-iteration (unknown type) between header and stop", () => {
		// loop/stop in the middle are caught by earlier checks; this guards the
		// "middle must be iterations" contract against a future record type.
		const stray = { type: "mystery" } as never;
		expect(() => validateLoopLog([header, stray, stop])).toThrow(/must be an iteration/);
	});
});

describe("convergence log: parse errors name the line", () => {
	test("a malformed JSON line throws with its 1-based line number", () => {
		const body = `${serializeLoopRecord(header)}\nnot json`;
		expect(() => parseLoopLog(body)).toThrow(/line 2: invalid JSON/);
	});

	test("a structurally invalid record throws with its line number", () => {
		const body = `${serializeLoopRecord(header)}\n${JSON.stringify({ type: "iteration", n: 1 })}`;
		expect(() => parseLoopLog(body)).toThrow(/line 2:/);
	});
});
