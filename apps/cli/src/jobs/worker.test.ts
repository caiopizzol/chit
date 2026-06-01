import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopVerdict } from "@chit-run/core";
import type { ConvergeExecute } from "../cli/converge.ts";
import { readLoop, startLoop } from "../loops/log-store.ts";
import { JobStore } from "./store.ts";
import type { JobRecord } from "./types.ts";
import { runJobWorker } from "./worker.ts";

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: JobStore;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-worker-cwd-"));
	stateDir = mkdtempSync(join(tmpdir(), "chit-worker-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new JobStore(join(stateDir, "chit", "jobs"));
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

// A scripted execute: one entry per iteration. {verdict} -> a successful run whose
// review carries that verdict; {fail} -> a graceful manifest failure (ok:false),
// optionally carrying an auditRunId (a transcript recorded before the run failed).
function fakeExecute(
	outcomes: Array<{ verdict?: LoopVerdict; fail?: string; auditRunId?: string }>,
): ConvergeExecute {
	let i = 0;
	return async () => {
		const o = outcomes[Math.min(i, outcomes.length - 1)];
		i++;
		if (o?.fail) {
			return {
				ok: false,
				failedStep: "implement",
				error: o.fail,
				outputs: {} as Record<string, string>,
				trace: [],
				...(o.auditRunId && { auditRunId: o.auditRunId }),
			};
		}
		const review = `looks fine\n\`\`\`json\n${JSON.stringify({
			verdict: o?.verdict ?? "proceed",
			findingCount: 0,
			checksRun: "tests",
			risk: "none",
		})}\n\`\`\``;
		return {
			ok: true,
			output: "## converge iteration",
			outputs: { implement: "did the slice", review },
			trace: [],
			auditRunId: `run-${i}`,
		};
	};
}

function seedJob(over: Partial<JobRecord> = {}): JobRecord {
	const loopId = over.loopId ?? "j1";
	// chit_converge_run reserves the loop (startLoop) before spawning the worker.
	startLoop(cwd, { scope: "s", task: "t", maxIterations: over.maxIterations ?? 3, loopId });
	const job = {
		jobId: "j1",
		loopId,
		repoKey: "k",
		cwd,
		scope: "s",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		state: "queued",
		createdAt: "2026-06-01T10:00:00.000Z",
		iterationsCompleted: 0,
		auditRefs: [],
		...over,
	} as JobRecord;
	store.create(job);
	return job;
}

const runDeps = (execute: ConvergeExecute) => ({
	jobStore: store,
	resolveExecute: () => ({ ok: true as const, execute }),
	installSignalHandlers: false,
	heartbeatMs: 1_000_000,
	now: () => 1000,
});

describe("background converge worker", () => {
	test("converges on the first iteration -> completed", async () => {
		seedJob();
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		const job = store.get("j1");
		expect(job).toMatchObject({
			state: "completed",
			stopStatus: "converged",
			iterationsCompleted: 1,
			auditRefs: ["run-1"],
		});
		expect(job?.phase).toBeUndefined();
		const recs = readLoop(cwd, "j1");
		expect(recs.map((r) => r.type)).toEqual(["loop", "iteration", "stop"]);
		expect(recs.at(-1)).toMatchObject({ type: "stop", status: "converged" });
	});

	test("revise then proceed -> completed after two iterations", async () => {
		seedJob();
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "revise" }, { verdict: "proceed" }])));
		expect(store.get("j1")).toMatchObject({
			state: "completed",
			stopStatus: "converged",
			iterationsCompleted: 2,
		});
	});

	test("never converges -> completed with max-iterations", async () => {
		seedJob({ maxIterations: 2 });
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "revise" }])));
		expect(store.get("j1")).toMatchObject({
			state: "completed",
			stopStatus: "max-iterations",
			iterationsCompleted: 2,
		});
	});

	test("reviewer block -> completed with blocked stop", async () => {
		seedJob();
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "block" }])));
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "blocked" });
		expect(readLoop(cwd, "j1").at(-1)).toMatchObject({ type: "stop", status: "blocked" });
	});

	test("manifest run failure -> failed", async () => {
		seedJob();
		await runJobWorker("j1", runDeps(fakeExecute([{ fail: "step exploded" }])));
		const job = store.get("j1");
		expect(job?.state).toBe("failed");
		expect(job?.failure).toContain("step exploded");
		expect(readLoop(cwd, "j1").at(-1)).toMatchObject({ type: "stop", status: "blocked" });
	});

	test("manifest run failure preserves the audit transcript ref in auditRefs", async () => {
		// Regression: a failed run that still produced a transcript must keep the
		// ref, so the failed job points at its receipt instead of an empty auditRefs.
		seedJob();
		await runJobWorker(
			"j1",
			runDeps(fakeExecute([{ fail: "step exploded", auditRunId: "audit-fail-1" }])),
		);
		const job = store.get("j1");
		expect(job?.state).toBe("failed");
		expect(job?.auditRefs).toEqual(["audit-fail-1"]);
	});

	test("clears phase and phaseStartedAt at a terminal state", async () => {
		seedJob();
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		const job = store.get("j1");
		expect(job?.phase).toBeUndefined();
		expect(job?.phaseStartedAt).toBeUndefined();
	});

	test("cancel intent before an iteration -> cancelled with no iteration record", async () => {
		const job = seedJob();
		store.update("j1", (c) => ({ ...c, cancelRequestedAt: "2026-06-01T10:05:00.000Z" }));
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		expect(store.get("j1")).toMatchObject({ state: "cancelled", stopStatus: "cancelled" });
		const recs = readLoop(cwd, "j1");
		expect(recs.filter((r) => r.type === "iteration")).toHaveLength(0);
		expect(recs.at(-1)).toMatchObject({ type: "stop", status: "cancelled" });
		expect(job.loopId).toBe("j1");
	});

	test("resolveExecute failure -> failed, loop closed blocked", async () => {
		seedJob();
		await runJobWorker("j1", {
			jobStore: store,
			resolveExecute: () => ({ ok: false, error: "bad manifest" }),
			installSignalHandlers: false,
			now: () => 1000,
		});
		expect(store.get("j1")).toMatchObject({ state: "failed", failure: "bad manifest" });
		expect(readLoop(cwd, "j1").at(-1)).toMatchObject({ type: "stop", status: "blocked" });
	});

	test("a non-queued job is left untouched (idempotent against double spawn)", async () => {
		seedJob({ state: "running" });
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		// still running, no iterations appended
		expect(store.get("j1")?.state).toBe("running");
		expect(readLoop(cwd, "j1").filter((r) => r.type === "iteration")).toHaveLength(0);
	});
});
