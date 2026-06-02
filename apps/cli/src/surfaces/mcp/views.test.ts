import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../../jobs/types.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";
import { backgroundRunView, loopRunView, oneShotRunView } from "./server.ts";

// The unified run views are the run_id surface: one public id and one vocabulary
// (chit_next / chit_status / chit_trace / chit_cancel). These tests pin the
// contract the maintainer set: control language uses run_id ONLY, never loop_id
// or job_id, and never the old chit_run_*/chit_converge_*/chit_job_* verbs. (The
// server.ts module is import-safe: it does not start a server on import.)

// Minimal fixtures (casts), matching the other MCP tests' style.
function oneShotRun(over: Partial<Run> = {}): Run {
	return {
		runId: "r1",
		manifest: { id: "consult", executionOrder: [["s"]], output: "s", dependencies: { s: [] } },
		records: { s: { stepId: "s", kind: "call", status: "pending" } },
		...over,
	} as unknown as Run;
}
function loopSession(over: Partial<ConvergeSession> = {}): ConvergeSession {
	return {
		loopId: "l1",
		iteration: 0,
		auditRefs: [],
		...over,
	} as unknown as ConvergeSession;
}
function job(over: Partial<JobRecord> = {}): JobRecord {
	// A live running job by default: this process's pid + a fresh heartbeat, so
	// isStale() is false and display is "running" (not derived-stale).
	return {
		jobId: "j1",
		loopId: "internal-loop",
		repoKey: "k",
		cwd: "/tmp/x",
		scope: "s",
		task: "t",
		maxIterations: 3,
		allowUnenforced: false,
		state: "running",
		createdAt: "2026-06-02T00:00:00.000Z",
		pid: process.pid,
		lastHeartbeatAt: new Date().toISOString(),
		iterationsCompleted: 0,
		auditRefs: [],
		...over,
	} as JobRecord;
}

// Serialize a view and assert it never leaks an internal id or an old verb.
function expectNoLeakage(view: unknown): void {
	const json = JSON.stringify(view);
	for (const banned of ["loop_id", "job_id", "loopId", "jobId", "chit_converge", "chit_job_"]) {
		expect(json).not.toContain(banned);
	}
}

describe("unified run views: run_id + unified vocabulary, no leakage", () => {
	test("one-shot view is keyed by run_id and points at the unified verbs", () => {
		const v = oneShotRunView(oneShotRun());
		expect(v.run_id).toBe("r1");
		expect(v.mode).toBe("foreground");
		expect(v.execution).toBe("one-shot");
		expect(v.complete).toBe(false);
		expect(v.nextAction).toContain("chit_next");
		expect(v.nextAction).toContain("chit_cancel");
		expectNoLeakage(v);
	});

	test("a complete one-shot view points at chit_trace, not chit_next", () => {
		const v = oneShotRunView(
			oneShotRun({
				records: { s: { stepId: "s", kind: "call", status: "done" } },
				outputs: { s: "the answer" },
			} as Partial<Run>),
		);
		expect(v.complete).toBe(true);
		expect(v.nextAction).toContain("chit_trace");
		expect(v.nextAction).not.toContain("chit_next");
		expectNoLeakage(v);
	});

	test("loop view is keyed by run_id (its loop id is internal) with unified verbs", () => {
		const v = loopRunView(loopSession({ loopId: "loop-abc", iteration: 2, lastVerdict: "revise" }));
		expect(v.run_id).toBe("loop-abc");
		expect(v.mode).toBe("foreground");
		expect(v.execution).toBe("loop");
		expect(v.status).toBe("open");
		expect(v.iterationsCompleted).toBe(2);
		expect(v.nextAction).toContain("chit_next");
		expectNoLeakage(v);
	});

	test("a running loop view tells you to cancel the in-flight iteration", () => {
		const v = loopRunView(loopSession({ active: new AbortController() }));
		expect(v.status).toBe("running");
		expect(v.nextAction).toContain("chit_cancel");
		expectNoLeakage(v);
	});

	test("a stopped loop view points at chit_trace", () => {
		const v = loopRunView(loopSession({ terminalStatus: "converged" }));
		expect(v.status).toBe("converged");
		expect(v.cancellable).toBe(false);
		expect(v.nextAction).toContain("chit_trace");
		expectNoLeakage(v);
	});

	test("background view is keyed by run_id (== job id), drops the job/loop handles", () => {
		const v = backgroundRunView(job({ jobId: "bg-7", auditRefs: ["aud-1"] }));
		expect(v.run_id).toBe("bg-7");
		expect(v.mode).toBe("background");
		expect(v.execution).toBe("job");
		expect(v.auditRefs).toEqual(["aud-1"]); // audit refs are fine to surface
		expect(v.nextAction).toContain("chit_status");
		expect(v.nextAction).toContain("chit_cancel");
		expectNoLeakage(v);
	});

	test("a finished background view points at chit_trace for the history", () => {
		const v = backgroundRunView(
			job({ jobId: "bg-9", state: "completed", stopStatus: "converged" }),
		);
		expect(v.display).toBe("completed");
		expect(v.nextAction).toContain("chit_trace");
		expectNoLeakage(v);
	});
});
