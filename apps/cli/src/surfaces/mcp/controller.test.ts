import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../../jobs/store.ts";
import type { JobRecord } from "../../jobs/types.ts";
import { RunController } from "./controller.ts";
import { ControllerStore } from "./controller-store.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";

// The controller resolves the ONE public id (run_id). These tests target that
// resolution contract directly (the unified chit_start/next/... tools that sit on
// it land in a later stage). The store only reads runId/records (one-shot) and
// loopId/active (loop), so minimal cast fixtures are enough.

let stateDir: string;
let savedXdg: string | undefined;
let jobs: JobStore;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "chit-ctrl-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	jobs = new JobStore(join(stateDir, "chit", "jobs"));
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(stateDir, { recursive: true, force: true });
});

function oneShotRun(runId: string): Run {
	return { runId, records: {} } as Run;
}
function loopSession(loopId: string, over: Partial<ConvergeSession> = {}): ConvergeSession {
	return {
		loopId,
		implementStep: "implement",
		reviewStep: "review",
		auditRefs: [],
		...over,
	} as ConvergeSession;
}
function seedJob(over: Partial<JobRecord> = {}): JobRecord {
	const job = {
		jobId: "bg1",
		loopId: "internal-loop-1",
		repoKey: "k",
		cwd: "/tmp/x",
		scope: "s",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		state: "running",
		createdAt: "2026-06-02T00:00:00.000Z",
		iterationsCompleted: 0,
		auditRefs: [],
		...over,
	} as JobRecord;
	jobs.create(job);
	return job;
}

describe("RunController run_id resolution", () => {
	test("foreground one-shot: run_id resolves to the one-shot run engine value", () => {
		const ctrl = new RunController(new ControllerStore(), jobs);
		const runId = ctrl.registerOneShot(oneShotRun("r1"), 0);
		expect(runId).toBe("r1");
		const r = ctrl.resolve("r1", 0);
		expect(r?.mode).toBe("foreground");
		if (r?.mode !== "foreground" || r.run.kind !== "one-shot") throw new Error("expected one-shot");
		expect(r.run.run.runId).toBe("r1");
		expect(ctrl.getOneShot("r1", 0)?.runId).toBe("r1");
		// A loop getter must not return a one-shot run.
		expect(ctrl.getLoop("r1", 0)).toBeUndefined();
	});

	test("foreground loop: run_id resolves to a ConvergeSession carrying its policy steps", () => {
		const ctrl = new RunController(new ControllerStore(), jobs);
		// Policy step names flow onto the session (Stage 2), so MCP next reads them.
		const runId = ctrl.registerLoop(
			loopSession("l1", { implementStep: "build", reviewStep: "check" }),
			0,
		);
		expect(runId).toBe("l1");
		const r = ctrl.resolve("l1", 0);
		if (r?.mode !== "foreground" || r.run.kind !== "loop") throw new Error("expected loop");
		expect(r.run.session.implementStep).toBe("build");
		expect(r.run.session.reviewStep).toBe("check");
		expect(ctrl.getLoop("l1", 0)?.implementStep).toBe("build");
	});

	test("background loop: durable job is keyed by run_id, its loop id is internal", () => {
		const ctrl = new RunController(new ControllerStore(), jobs);
		const job = seedJob({ jobId: "bg1", loopId: "internal-loop-1" });
		const r = ctrl.resolve("bg1", 0);
		expect(r?.mode).toBe("background");
		if (r?.mode !== "background") throw new Error("expected background");
		// run_id IS the job id; the loop id is a separate, internal field.
		expect(r.job.jobId).toBe("bg1");
		expect(r.job.loopId).toBe("internal-loop-1");
		expect(r.job.loopId).not.toBe(r.job.jobId);
		// You cannot resolve a run by its INTERNAL loop id — only by run_id.
		expect(ctrl.resolve(job.loopId, 0)).toBeUndefined();
	});

	test("status distinguishes an unknown foreground id from a durable background id after a fresh store", () => {
		// First server process: a foreground run and a background job both exist.
		const store1 = new ControllerStore();
		const ctrl1 = new RunController(store1, jobs);
		ctrl1.registerOneShot(oneShotRun("fg1"), 0);
		seedJob({ jobId: "bg1", loopId: "internal-loop-1" });
		expect(ctrl1.resolve("fg1", 0)?.mode).toBe("foreground");
		expect(ctrl1.resolve("bg1", 0)?.mode).toBe("background");

		// Simulate a fresh server: new in-memory store, same durable JobStore.
		const ctrl2 = new RunController(new ControllerStore(), jobs);
		// The foreground run is gone (in-memory only — "this session supervised it").
		expect(ctrl2.resolve("fg1", 0)).toBeUndefined();
		// The background run survives the reconnect (durable, keyed by run_id).
		expect(ctrl2.resolve("bg1", 0)?.mode).toBe("background");
	});

	test("trace exposes audit refs but run_id is never one of them", () => {
		const ctrl = new RunController(new ControllerStore(), jobs);
		seedJob({ jobId: "bg1", auditRefs: ["aud-1", "aud-2"] });
		const r = ctrl.resolve("bg1", 0);
		if (r?.mode !== "background") throw new Error("expected background");
		expect(r.job.auditRefs).toEqual(["aud-1", "aud-2"]);
		// run_id is the run handle, not an audit id: it never appears among them.
		expect(r.job.auditRefs).not.toContain("bg1");
	});

	test("an unknown run_id resolves to nothing (no throw, no leakage)", () => {
		const ctrl = new RunController(new ControllerStore(), jobs);
		expect(ctrl.resolve("nope", 0)).toBeUndefined();
	});
});
