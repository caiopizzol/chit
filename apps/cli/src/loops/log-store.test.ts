import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoopLog, validateLoopLog } from "@chit/core";
import {
	appendIteration,
	type Clock,
	LoopStoreError,
	readLoop,
	startLoop,
	stopLoop,
} from "./log-store.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-loop-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

// A clock that advances by 1s on each call, so timestamps/durations are
// deterministic and strictly increasing.
function fakeClock(startMs: number, stepMs = 1000): Clock {
	let t = startMs;
	return () => {
		const v = t;
		t += stepMs;
		return v;
	};
}

const baseAppend = {
	implementSummary: "did a thing",
	changedFiles: ["a.ts"],
	checksRun: "tests",
	verdict: "revise" as const,
	findingCount: 2,
	decision: "revise" as const,
	checkDurationMs: 18000,
};

function start(loopId = "L1", clock?: Clock) {
	return startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId, clock });
}

describe("loop-log store: start", () => {
	test("creates .chit/loops/<id>.jsonl with a valid header", () => {
		const { loopId, path } = start("L1");
		expect(loopId).toBe("L1");
		expect(path).toBe(join(cwd, ".chit", "loops", "L1.jsonl"));
		const recs = validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")));
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({ type: "loop", scope: "s", task: "t", repo: cwd });
	});

	test("generates a loopId when none is given", () => {
		const { loopId } = startLoop(cwd, { scope: "s", task: "t", maxIterations: 3 });
		expect(loopId).toMatch(/[0-9a-f-]{36}/);
	});

	test("refuses to overwrite an existing log unless force", () => {
		start("L1");
		expect(() => start("L1")).toThrow(/already exists/);
		// force overwrites: a fresh header, no prior iterations.
		appendIteration(cwd, "L1", baseAppend);
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "L1", force: true });
		expect(readLoop(cwd, "L1")).toHaveLength(1);
	});

	test("rejects an unsafe loopId (path traversal)", () => {
		expect(() => start("../evil")).toThrow(LoopStoreError);
		expect(() => start("a/b")).toThrow(LoopStoreError);
	});
});

describe("loop-log store: append", () => {
	test("computes sequential 1-based iteration numbers itself", () => {
		start("L1");
		expect(appendIteration(cwd, "L1", baseAppend).n).toBe(1);
		expect(appendIteration(cwd, "L1", baseAppend).n).toBe(2);
		expect(appendIteration(cwd, "L1", baseAppend).n).toBe(3);
		const iters = readLoop(cwd, "L1").filter((r) => r.type === "iteration");
		expect(iters.map((r) => (r.type === "iteration" ? r.n : 0))).toEqual([1, 2, 3]);
	});

	test("records decision distinct from verdict (no forced match)", () => {
		start("L1");
		appendIteration(cwd, "L1", { ...baseAppend, verdict: "revise", decision: "proceed" });
		const it = readLoop(cwd, "L1").find((r) => r.type === "iteration");
		expect(it).toMatchObject({ verdict: "revise", decision: "proceed" });
	});

	test("refuses to append after a stop", () => {
		start("L1");
		appendIteration(cwd, "L1", baseAppend);
		stopLoop(cwd, "L1", { status: "converged", reason: "done" });
		expect(() => appendIteration(cwd, "L1", baseAppend)).toThrow(/already stopped/);
	});

	test("throws a clean error for a missing loop", () => {
		expect(() => appendIteration(cwd, "ghost", baseAppend)).toThrow(/no loop log/);
	});
});

describe("loop-log store: stop", () => {
	test("computes iterations from records and elapsed from the header clock", () => {
		// header at t=1000; two appends; stop at a later clock.
		start("L1", fakeClock(1000));
		appendIteration(cwd, "L1", baseAppend);
		appendIteration(cwd, "L1", baseAppend);
		const res = stopLoop(cwd, "L1", {
			status: "converged",
			reason: "done",
			clock: () => 1000 + 5000,
		});
		expect(res.iterations).toBe(2);
		expect(res.totalElapsedMs).toBe(5000);
		const stop = readLoop(cwd, "L1").find((r) => r.type === "stop");
		expect(stop).toMatchObject({ iterations: 2, totalElapsedMs: 5000, status: "converged" });
	});

	test("refuses a double stop", () => {
		start("L1");
		stopLoop(cwd, "L1", { status: "converged", reason: "done" });
		expect(() => stopLoop(cwd, "L1", { status: "blocked", reason: "x" })).toThrow(
			/already stopped/,
		);
	});
});

describe("loop-log store: produced file integrity", () => {
	test("a full start -> append -> stop file passes structural validation", () => {
		const { path } = start("L1", fakeClock(1000));
		appendIteration(cwd, "L1", baseAppend);
		appendIteration(cwd, "L1", { ...baseAppend, verdict: "proceed", decision: "proceed" });
		stopLoop(cwd, "L1", { status: "converged", reason: "proceed + complete" });
		expect(() => validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")))).not.toThrow();
		expect(existsSync(path)).toBe(true);
	});

	test("readLoop validates structure and returns records in order", () => {
		start("L1");
		appendIteration(cwd, "L1", baseAppend);
		stopLoop(cwd, "L1", { status: "converged", reason: "done" });
		const recs = readLoop(cwd, "L1");
		expect(recs.map((r) => r.type)).toEqual(["loop", "iteration", "stop"]);
	});
});

describe("loop-log store: rejects inconsistent pre-existing files", () => {
	function seedRaw(loopId: string, lines: object[]) {
		const dir = join(cwd, ".chit", "loops");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${loopId}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	}
	const headerObj = (loopId: string, maxIterations = 3) => ({
		type: "loop",
		schema: 1,
		loopId,
		scope: "s",
		task: "t",
		repo: cwd,
		startedAt: "2026-05-29T10:00:00.000Z",
		maxIterations,
	});

	test("rejects a file whose header loopId does not match the requested id", () => {
		seedRaw("L1", [headerObj("OTHER")]);
		expect(() => readLoop(cwd, "L1")).toThrow(/declares loopId/);
		expect(() => appendIteration(cwd, "L1", baseAppend)).toThrow(/declares loopId/);
	});

	test("fails loudly on a non-sequential iteration in a hand-edited log", () => {
		seedRaw("L2", [
			headerObj("L2"),
			{ type: "iteration", n: 99, ...baseAppend, at: "2026-05-29T10:01:00.000Z" },
		]);
		expect(() => appendIteration(cwd, "L2", baseAppend)).toThrow(/sequential/);
	});

	test("append refuses once the maxIterations budget is reached", () => {
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 1, loopId: "M1" });
		expect(appendIteration(cwd, "M1", baseAppend).n).toBe(1);
		expect(() => appendIteration(cwd, "M1", baseAppend)).toThrow(/iteration budget/);
	});
});
