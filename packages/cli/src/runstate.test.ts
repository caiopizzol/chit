import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConvergeReceipt } from "./converge.ts";
import { appendRunEvent, initRunEvents } from "./events.ts";
import type { LiveProcess, LiveRun } from "./live.ts";
import { registerLiveRun } from "./live.ts";
import type { RunReceipt } from "./run.ts";
import { finishedStateFromReceipt, liveRunState, readRunState, receiptExitCode } from "./runstate.ts";
import { saveReceipt } from "./store.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "chit-runstate-"));
	dirs.push(d);
	return d;
}

const alive: LiveProcess = { isAlive: () => true, kill: () => {} };
const dead: LiveProcess = { isAlive: () => false, kill: () => {} };

function oneShot(over: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "run-1",
		routineId: "plan",
		policy: "one-shot",
		digest: "sha256:a",
		inputs: { idea: "x" },
		startedAt: 1000,
		finishedAt: 2000,
		elapsedMs: 1000,
		status: "completed",
		steps: [],
		...over,
	};
}

function converge(over: Partial<ConvergeReceipt> = {}): ConvergeReceipt {
	return {
		runId: "run-2",
		routineId: "implement",
		policy: "converge",
		digest: "sha256:b",
		inputs: { task: "x" },
		maxIterations: 3,
		until: "checks-pass",
		startedAt: 1000,
		finishedAt: 2000,
		elapsedMs: 1000,
		status: "converged",
		iterations: [],
		...over,
	};
}

function live(over: Partial<LiveRun> = {}): LiveRun {
	return { runId: "run-live", routineId: "implement", pid: 4242, startedAt: 1000, cwd: "/repo", ...over };
}

describe("receiptExitCode", () => {
	test("maps each terminal status to the code wait would return", () => {
		expect(receiptExitCode(oneShot({ status: "completed" }))).toBe(0);
		expect(receiptExitCode(oneShot({ status: "failed" }))).toBe(1);
		expect(receiptExitCode(oneShot({ status: "cancelled" }))).toBe(130);
		expect(receiptExitCode(converge({ status: "converged" }))).toBe(0);
		expect(receiptExitCode(converge({ status: "did-not-converge" }))).toBe(1);
		// A converged run whose write-back failed is still a failure to wait on.
		expect(receiptExitCode(converge({ status: "converged", applyError: "dirty tree" }))).toBe(1);
	});
});

describe("liveRunState", () => {
	test("starting until a ready event, then running", () => {
		const r = live();
		const starting = liveRunState(r, [], 3000);
		expect(starting.phase).toBe("starting");
		expect(starting.done).toBe(false);
		expect(starting.pid).toBe(4242);
		expect(starting.cwd).toBe("/repo");
		expect(starting.elapsedMs).toBe(2000); // now - startedAt
		expect(starting.status).toBeUndefined(); // no receipt -> no terminal status

		const running = liveRunState(r, [{ at: 1, kind: "ready" }], 3000);
		expect(running.phase).toBe("running");
		expect(running.done).toBe(false);
	});
});

describe("readRunState", () => {
	test("a finished receipt becomes finished state with status, exitCode, and digest", async () => {
		const dir = tmp();
		saveReceipt(dir, converge({ runId: "run-fin", status: "did-not-converge", scope: "SD-7" }));
		const s = await readRunState(dir, "run-fin", { now: 9999, process: alive });
		expect(s).toBeDefined();
		expect(s?.phase).toBe("finished");
		expect(s?.done).toBe(true);
		expect(s?.status).toBe("did-not-converge");
		expect(s?.exitCode).toBe(1);
		expect(s?.scope).toBe("SD-7");
		expect(s?.digest).toBe("sha256:b");
		expect(s?.elapsedMs).toBe(1000); // the receipt's exact elapsed, not now - startedAt
		expect(s?.patch).toBeUndefined(); // non-sandboxed -> no patch reported
	});

	test("a receipt wins even while a live entry still lingers", async () => {
		const dir = tmp();
		saveReceipt(dir, oneShot({ runId: "run-both", status: "completed" }));
		registerLiveRun(dir, live({ runId: "run-both" }));
		const s = await readRunState(dir, "run-both", { now: 5000, process: alive });
		expect(s?.phase).toBe("finished");
		expect(s?.done).toBe(true);
		expect(s?.exitCode).toBe(0);
	});

	test("an alive process with no receipt is starting, then running once ready", async () => {
		const dir = tmp();
		registerLiveRun(dir, live({ runId: "run-a", startedAt: 1000 }));
		initRunEvents(dir, "run-a");
		expect((await readRunState(dir, "run-a", { now: 2000, process: alive }))?.phase).toBe("starting");
		appendRunEvent(dir, "run-a", { at: 1500, kind: "ready", baseCommit: "deadbeef" });
		expect((await readRunState(dir, "run-a", { now: 2000, process: alive }))?.phase).toBe("running");
	});

	test("a dead process with no receipt is orphaned, carrying any startup error", async () => {
		const dir = tmp();
		registerLiveRun(dir, live({ runId: "run-dead" }));
		const generic = await readRunState(dir, "run-dead", { now: 3000, process: dead });
		expect(generic?.phase).toBe("orphaned");
		expect(generic?.done).toBe(true);
		expect(generic?.exitCode).toBe(1);
		expect(generic?.error).toContain("without writing a receipt");

		initRunEvents(dir, "run-dead");
		appendRunEvent(dir, "run-dead", { at: 1, kind: "failed", error: "preflight refused: dirty tree" });
		const withErr = await readRunState(dir, "run-dead", { now: 3000, process: dead });
		expect(withErr?.error).toBe("preflight refused: dirty tree");
	});

	test("an unknown id (no receipt, no live entry) is undefined", async () => {
		expect(await readRunState(tmp(), "run-ghost", { now: 0, process: alive })).toBeUndefined();
	});
});

describe("finishedStateFromReceipt", () => {
	test("builds finished state without a patch for a non-sandboxed run", async () => {
		const s = await finishedStateFromReceipt(tmp(), oneShot({ runId: "run-x", output: "done" }));
		expect(s.phase).toBe("finished");
		expect(s.status).toBe("completed");
		expect(s.exitCode).toBe(0);
		expect(s.patch).toBeUndefined();
		expect(s.applied).toBeUndefined();
	});
});
