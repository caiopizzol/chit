import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoopLog, validateLoopLog } from "@chit-run/core";
import { loopLogDir } from "./location.ts";
import {
	appendIteration,
	type Clock,
	findLoopByRunId,
	LoopStoreError,
	readLoop,
	startLoop,
	stopLoop,
} from "./log-store.ts";

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-loop-"));
	// Redirect the loop state dir to an isolated temp dir so tests never touch
	// the real ~/.local/state and stay independent. location.ts honors this.
	stateDir = mkdtempSync(join(tmpdir(), "chit-loop-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
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
	test("creates the log under the state dir (not the repo) with a valid header", () => {
		const { loopId, path } = start("L1");
		expect(loopId).toBe("L1");
		// The log lives under the state dir, keyed by repo, NOT in the repo.
		expect(path).toBe(join(loopLogDir(cwd), "L1.jsonl"));
		expect(path.startsWith(stateDir)).toBe(true);
		expect(existsSync(join(cwd, ".chit"))).toBe(false);
		const recs = validateLoopLog(parseLoopLog(readFileSync(path, "utf-8")));
		expect(recs).toHaveLength(1);
		// repo is the canonical repo root (realpath of the cwd here, no git repo),
		// and repoKey is recorded for the namespaced location.
		expect(recs[0]).toMatchObject({ type: "loop", scope: "s", task: "t", repo: realpathSync(cwd) });
		expect(recs[0]).toHaveProperty("repoKey");
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

	test("persists optional usage and reads it back; absent when not passed", () => {
		start("L1");
		appendIteration(cwd, "L1", {
			...baseAppend,
			usage: { inputTokens: 300, outputTokens: 80, estimatedCostUsd: 0.05 },
		});
		appendIteration(cwd, "L1", baseAppend);
		const iters = readLoop(cwd, "L1").filter((r) => r.type === "iteration");
		expect(iters[0]).toMatchObject({
			usage: { inputTokens: 300, outputTokens: 80, estimatedCostUsd: 0.05 },
		});
		expect("usage" in iters[1]).toBe(false);
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

	test("persists optional workspaceWarnings; absent when empty/not passed", () => {
		start("L1");
		appendIteration(cwd, "L1", {
			...baseAppend,
			workspaceWarnings: ["untracked generated artifact: __pycache__/x.pyc"],
		});
		appendIteration(cwd, "L1", { ...baseAppend, workspaceWarnings: [] });
		const iters = readLoop(cwd, "L1").filter((r) => r.type === "iteration");
		expect(iters[0]).toMatchObject({
			workspaceWarnings: ["untracked generated artifact: __pycache__/x.pyc"],
		});
		// An empty warnings list is omitted, not written as [].
		expect("workspaceWarnings" in iters[1]).toBe(false);
	});
});

describe("loop-log store: rejects inconsistent pre-existing files", () => {
	function seedRaw(loopId: string, lines: object[]) {
		const dir = loopLogDir(cwd);
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
		repoKey: "k",
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

describe("loop-log store: header workspace metadata + findLoopByRunId (#100)", () => {
	const ws = {
		worktreePath: "/wt/run-1/owner",
		branch: "chit-run/run-1/owner",
		baseSha: "basesha",
		mainRepo: "/main/repo",
		callerCheckout: "/launching/checkout",
	};
	const participants = {
		impl: {
			agentId: "claude",
			adapter: "claude-cli",
			session: "per_scope" as const,
			permissions: { filesystem: "write" as const },
			enforcesReadOnly: false,
			config: { model: "claude-opus-4", envKeys: ["ANTHROPIC_API_KEY"] },
		},
	};

	test("startLoop records the workspace metadata in the header; it round-trips", () => {
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "W1", workspace: ws });
		const header = readLoop(cwd, "W1")[0] as unknown as { type: string } & typeof ws;
		expect(header.worktreePath).toBe(ws.worktreePath);
		expect(header.branch).toBe(ws.branch);
		expect(header.baseSha).toBe(ws.baseSha);
		expect(header.mainRepo).toBe(ws.mainRepo);
		expect(header.callerCheckout).toBe(ws.callerCheckout);
	});

	test("a header WITHOUT workspace metadata (in_place / old log) has the fields undefined", () => {
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "W2" });
		const header = readLoop(cwd, "W2")[0] as unknown as Record<string, unknown>;
		expect(header.worktreePath).toBeUndefined();
		expect(header.mainRepo).toBeUndefined();
	});

	test("startLoop records participant provenance in the durable header; it round-trips redacted", () => {
		const recipe = {
			id: "deep-feature",
			mode: "converge" as const,
			origin: { source: "repo" as const, path: "/repo/chit.config.json" },
			maxIterations: 4,
			callTimeoutMs: 1200000,
			description: "Use the deeper feature loop",
		};
		startLoop(cwd, {
			scope: "s",
			task: "t",
			maxIterations: 3,
			loopId: "P1",
			workspace: ws,
			participants,
			recipe,
		});
		const header = readLoop(cwd, "P1")[0] as unknown as Record<string, unknown>;
		expect(header.participants).toEqual(participants);
		expect(header.recipe).toEqual(recipe);
		expect(JSON.stringify(header.participants)).not.toContain("sk-");
		expect(JSON.stringify(header.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});

	test("findLoopByRunId resolves a loop by runId alone, without its repoKey", () => {
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "F1", workspace: ws });
		const found = findLoopByRunId("F1");
		expect(found).toBeDefined();
		expect(found?.header.loopId).toBe("F1");
		expect(found?.header.mainRepo).toBe(ws.mainRepo);
		expect(found?.stop).toBeUndefined(); // not stopped yet
	});

	test("findLoopByRunId surfaces the stop record once the loop has stopped", () => {
		startLoop(cwd, { scope: "s", task: "t", maxIterations: 3, loopId: "F2" });
		stopLoop(cwd, "F2", { status: "converged", reason: "done" });
		const found = findLoopByRunId("F2");
		expect(found?.stop?.status).toBe("converged");
	});

	test("findLoopByRunId returns undefined for an unknown runId", () => {
		expect(findLoopByRunId("nope-does-not-exist")).toBeUndefined();
	});

	test("findLoopByRunId rejects an unsafe runId (no path traversal)", () => {
		expect(() => findLoopByRunId("../escape")).toThrow(LoopStoreError);
	});
});
