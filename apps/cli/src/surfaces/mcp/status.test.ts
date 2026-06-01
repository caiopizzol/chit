import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "../../audit/store.ts";
import { JobStore } from "../../jobs/store.ts";
import type { JobRecord } from "../../jobs/types.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import { ConvergeStore } from "./converge-store.ts";
import type { Run } from "./engine.ts";
import { RunStore } from "./run-store.ts";
import { buildStatus, summarizeRunForStatus } from "./status.ts";

const NOW = Date.parse("2026-06-01T11:00:00.000Z");

// A fresh, empty job store under a temp dir (never touches the real state dir).
function emptyJobStore(): JobStore {
	return new JobStore(mkdtempSync(join(tmpdir(), "chit-status-jobs-")));
}

// Minimal Run: the status summary reads only runId, manifest.id, records, the
// manifest dependencies (for readySteps), recorder, and startedAtMs (the
// newest-first sort key). A cast keeps the fixture small, matching
// run-store.test's fakeRun.
function fakeRun(
	runId: string,
	opts: { done?: boolean; audited?: boolean; startedAtMs?: number } = {},
): Run {
	return {
		runId,
		manifest: { id: "m", dependencies: { s: [] }, output: "s" },
		records: { s: { stepId: "s", kind: "call", status: opts.done ? "done" : "pending" } },
		recorder: opts.audited ? { lastError: undefined } : undefined,
		startedAtMs: opts.startedAtMs ?? 0,
	} as unknown as Run;
}

// Minimal session: describeConverge reads the listed fields (the rest stay
// undefined, an open never-run loop); startedAtMs is the newest-first sort key.
function fakeSession(loopId: string, startedAtMs = 0): ConvergeSession {
	return {
		loopId,
		scope: "sc",
		cwd: "/repo",
		task: "t",
		maxIterations: 3,
		iteration: 0,
		auditRefs: [],
		startedAtMs,
	} as unknown as ConvergeSession;
}

// A fresh, empty audit store (its runs dir does not exist yet), so `recent` is
// deterministically empty and the real ~/.local/state/chit/audit is never read.
function emptyAuditStore(): AuditStore {
	return new AuditStore(mkdtempSync(join(tmpdir(), "chit-status-audit-")));
}

describe("buildStatus", () => {
	test("empty stores produce empty active sections and empty recent", () => {
		const status = buildStatus(
			new RunStore(),
			new ConvergeStore(),
			emptyAuditStore(),
			emptyJobStore(),
			5,
			NOW,
		);
		expect(status.active.runs).toEqual([]);
		expect(status.active.loops).toEqual([]);
		expect(status.jobs).toEqual([]);
		expect(status.recent).toEqual([]);
	});

	test("durable jobs: in-flight always shown, terminal capped, stale derived", () => {
		const jobStore = emptyJobStore();
		const base: Omit<JobRecord, "jobId" | "loopId" | "state" | "createdAt"> = {
			repoKey: "k",
			cwd: "/repo",
			scope: "s",
			task: "t",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 0,
			auditRefs: [],
		};
		// a live running job (fresh heartbeat, this process's pid => alive)
		jobStore.create({
			...base,
			jobId: "live",
			loopId: "live",
			state: "running",
			createdAt: "2026-06-01T10:03:00.000Z",
			pid: process.pid,
			lastHeartbeatAt: new Date(NOW).toISOString(),
		});
		// a stale running job (heartbeat ancient => derived stale)
		jobStore.create({
			...base,
			jobId: "stale",
			loopId: "stale",
			state: "running",
			createdAt: "2026-06-01T10:02:00.000Z",
			pid: process.pid,
			lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
		});
		jobStore.create({
			...base,
			jobId: "done",
			loopId: "done",
			state: "completed",
			createdAt: "2026-06-01T10:01:00.000Z",
			stopStatus: "converged",
		});

		const status = buildStatus(
			new RunStore(),
			new ConvergeStore(),
			emptyAuditStore(),
			jobStore,
			5,
			NOW,
		);
		const byId = Object.fromEntries(status.jobs.map((j) => [j.jobId, j]));
		expect(byId.live?.display).toBe("running");
		expect(byId.stale?.display).toBe("stale");
		expect(byId.done?.display).toBe("completed");
		expect(byId.done?.stopStatus).toBe("converged");
	});

	test("summarizes a pending run as not-complete with its ready step", () => {
		expect(summarizeRunForStatus(fakeRun("r1"))).toEqual({
			run_id: "r1",
			manifest: "m",
			complete: false,
			ready: ["s"],
			audited: false,
		});
	});

	test("a done audited run is complete, has no ready steps, and is audited", () => {
		expect(summarizeRunForStatus(fakeRun("r2", { done: true, audited: true }))).toEqual({
			run_id: "r2",
			manifest: "m",
			complete: true,
			ready: [],
			audited: true,
		});
	});

	test("active runs and loops are listed newest-first by startedAtMs", () => {
		const runs = new RunStore();
		runs.add(fakeRun("old", { startedAtMs: 0 }), 0);
		runs.add(fakeRun("new", { startedAtMs: 1 }), 1);
		const loops = new ConvergeStore();
		loops.add(fakeSession("loop-old", 0), 0);
		loops.add(fakeSession("loop-new", 1), 1);

		const status = buildStatus(runs, loops, emptyAuditStore(), emptyJobStore(), 5, NOW);

		expect(status.active.runs.map((r) => r.run_id)).toEqual(["new", "old"]);
		expect(status.active.loops.map((l) => l.loopId)).toEqual(["loop-new", "loop-old"]);
		// each loop carries the same control-plane view chit_converge_status returns
		expect(status.active.loops[0]?.status).toBe("open");
		expect(status.active.loops[0]?.nextAction).toContain("chit_converge_next");
	});

	test("a loop restarted in place still sorts newest by its new startedAtMs", () => {
		// Map#set on an existing key keeps the original insertion slot, so a plain
		// reverse-of-insertion would misorder a force-restarted loop. Sorting by
		// startedAtMs fixes that: re-adding loop-a with a later start moves it first.
		const loops = new ConvergeStore();
		loops.add(fakeSession("loop-a", 0), 0);
		loops.add(fakeSession("loop-b", 1), 1);
		loops.add(fakeSession("loop-a", 2), 2); // restarted with a later startedAtMs

		const status = buildStatus(new RunStore(), loops, emptyAuditStore(), emptyJobStore(), 5, NOW);

		expect(status.active.loops.map((l) => l.loopId)).toEqual(["loop-a", "loop-b"]);
	});

	test("recent_limit of 0 returns no recent runs", () => {
		const status = buildStatus(
			new RunStore(),
			new ConvergeStore(),
			emptyAuditStore(),
			emptyJobStore(),
			0,
			NOW,
		);
		expect(status.recent).toEqual([]);
	});

	test("recent degrades to [] when the audit store cannot be read", () => {
		// A throwing audit store must not mask the active control plane: active is
		// returned, recent degrades to []. (chit_audit_list still surfaces the error.)
		const throwingStore = {
			listRuns() {
				throw new Error("audit dir unavailable");
			},
		} as unknown as AuditStore;
		const runs = new RunStore();
		runs.add(fakeRun("r1", { startedAtMs: 0 }), 0);

		const status = buildStatus(runs, new ConvergeStore(), throwingStore, emptyJobStore(), 5, NOW);

		expect(status.active.runs.map((r) => r.run_id)).toEqual(["r1"]);
		expect(status.recent).toEqual([]);
	});
});
