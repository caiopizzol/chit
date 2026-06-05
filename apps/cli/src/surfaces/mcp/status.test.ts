import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore } from "../../audit/store.ts";
import { JobStore } from "../../jobs/store.ts";
import type { LoopJobRecord } from "../../jobs/types.ts";
import { RunController } from "./controller.ts";
import { ControllerStore } from "./controller-store.ts";
import type { ConvergeSession } from "./converge-engine.ts";
import type { Run } from "./engine.ts";
import {
	buildStatus,
	needsDecisionNextAction,
	publicRunSummary,
	publicTimeline,
	summarizeRunForStatus,
} from "./status.ts";

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

// A controller seeded with foreground runs/sessions, for buildStatus. The merged
// store holds both kinds keyed by run_id; buildStatus splits them back out.
function controllerOf(runs: Run[] = [], sessions: ConvergeSession[] = []): RunController {
	const c = new RunController(new ControllerStore(), emptyJobStore());
	for (const r of runs) c.registerOneShot(r, 0);
	for (const s of sessions) c.registerLoop(s, 0);
	return c;
}
function emptyController(): RunController {
	return controllerOf();
}

describe("buildStatus", () => {
	test("empty stores produce empty active sections and empty recent", () => {
		const status = buildStatus(emptyController(), emptyAuditStore(), emptyJobStore(), 5, NOW);
		expect(status.active.runs).toEqual([]);
		expect(status.active.loops).toEqual([]);
		expect(status.jobs).toEqual([]);
		expect(status.recent).toEqual([]);
	});

	test("durable jobs: in-flight always shown, terminal capped, stale derived", () => {
		const jobStore = emptyJobStore();
		const base: Omit<LoopJobRecord, "runId" | "loopId" | "state" | "createdAt"> = {
			policy: "loop",
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
			runId: "live",
			loopId: "live",
			state: "running",
			createdAt: "2026-06-01T10:03:00.000Z",
			pid: process.pid,
			lastHeartbeatAt: new Date(NOW).toISOString(),
		});
		// a stale running job (heartbeat ancient => derived stale)
		jobStore.create({
			...base,
			runId: "stale",
			loopId: "stale",
			state: "running",
			createdAt: "2026-06-01T10:02:00.000Z",
			pid: process.pid,
			lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
		});
		jobStore.create({
			...base,
			runId: "done",
			loopId: "done",
			state: "completed",
			createdAt: "2026-06-01T10:01:00.000Z",
			stopStatus: "converged",
		});

		const status = buildStatus(emptyController(), emptyAuditStore(), jobStore, 5, NOW);
		const byId = Object.fromEntries(status.jobs.map((j) => [j.run_id, j]));
		expect(byId.live?.display).toBe("running");
		expect(byId.stale?.display).toBe("stale");
		expect(byId.done?.display).toBe("completed");
		expect(byId.done?.stopStatus).toBe("converged");
	});

	test("a background loop job's callTimeoutMs override is surfaced in the overview (and omitted when unset)", () => {
		const jobStore = emptyJobStore();
		const base: Omit<LoopJobRecord, "runId" | "loopId" | "state" | "createdAt"> = {
			policy: "loop",
			repoKey: "k",
			cwd: "/repo",
			scope: "s",
			task: "t",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 0,
			auditRefs: [],
		};
		jobStore.create({
			...base,
			runId: "withCt",
			loopId: "withCt",
			state: "completed",
			createdAt: "2026-06-01T10:01:00.000Z",
			callTimeoutMs: 600_000,
		});
		jobStore.create({
			...base,
			runId: "noCt",
			loopId: "noCt",
			state: "completed",
			createdAt: "2026-06-01T10:00:00.000Z",
		});
		const status = buildStatus(emptyController(), emptyAuditStore(), jobStore, 5, NOW);
		const byId = Object.fromEntries(status.jobs.map((j) => [j.run_id, j]));
		expect(byId.withCt?.callTimeoutMs).toBe(600_000); // the override shows in the list view
		expect(byId.noCt?.callTimeoutMs).toBeUndefined(); // absent when no override was set
	});

	test("running job: timing fields + nextAction names the phase and ages", () => {
		const jobStore = emptyJobStore();
		jobStore.create({
			repoKey: "k",
			cwd: "/repo",
			scope: "s",
			task: "t",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 0,
			auditRefs: [],
			policy: "loop",
			runId: "run1",
			loopId: "run1",
			state: "running",
			createdAt: "2026-06-01T10:55:00.000Z",
			startedAt: new Date(NOW - 120_000).toISOString(),
			pid: process.pid,
			lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
			phase: "implementing",
			phaseStartedAt: new Date(NOW - 30_000).toISOString(),
		});
		const status = buildStatus(emptyController(), emptyAuditStore(), jobStore, 5, NOW);
		const j = status.jobs.find((x) => x.run_id === "run1");
		expect(j?.elapsedMs).toBe(120_000);
		expect(j?.lastHeartbeatAgeMs).toBe(5_000);
		expect(j?.phaseElapsedMs).toBe(30_000);
		// Human-readable nextAction names the phase and how long it has run.
		expect(j?.nextAction).toContain("running for 2m");
		expect(j?.nextAction).toContain("implementing for 30s");
	});

	test("terminal job with no audit refs does not tell the operator to open a transcript", () => {
		const jobStore = emptyJobStore();
		jobStore.create({
			repoKey: "k",
			cwd: "/repo",
			scope: "s",
			task: "t",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 0,
			auditRefs: [],
			policy: "loop",
			runId: "fail1",
			loopId: "fail1",
			state: "failed",
			createdAt: "2026-06-01T10:50:00.000Z",
			failure: "boom",
		});
		const status = buildStatus(emptyController(), emptyAuditStore(), jobStore, 5, NOW);
		const j = status.jobs.find((x) => x.run_id === "fail1");
		expect(j?.nextAction).not.toContain("chit_audit_show");
	});

	test("terminal job WITH an audit ref points at that exact ref", () => {
		const jobStore = emptyJobStore();
		jobStore.create({
			repoKey: "k",
			cwd: "/repo",
			scope: "s",
			task: "t",
			maxIterations: 3,
			allowUnenforced: false,
			iterationsCompleted: 1,
			auditRefs: ["aud-xyz"],
			policy: "loop",
			runId: "done1",
			loopId: "done1",
			state: "completed",
			createdAt: "2026-06-01T10:50:00.000Z",
			stopStatus: "converged",
		});
		const status = buildStatus(emptyController(), emptyAuditStore(), jobStore, 5, NOW);
		const j = status.jobs.find((x) => x.run_id === "done1");
		// nextAction names the audit_ref argument explicitly, so a cold agent calls
		// chit_audit_show correctly first-try (the receipt handle, not a control run_id).
		expect(j?.nextAction).toContain('chit_audit_show { audit_ref: "aud-xyz" }');
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
		const status = buildStatus(
			controllerOf(
				[fakeRun("old", { startedAtMs: 0 }), fakeRun("new", { startedAtMs: 1 })],
				[fakeSession("loop-old", 0), fakeSession("loop-new", 1)],
			),
			emptyAuditStore(),
			emptyJobStore(),
			5,
			NOW,
		);

		expect(status.active.runs.map((r) => r.run_id)).toEqual(["new", "old"]);
		expect(status.active.loops.map((l) => l.run_id)).toEqual(["loop-new", "loop-old"]);
		// each loop is presented under run_id with the unified verbs
		expect(status.active.loops[0]?.status).toBe("open");
		expect(status.active.loops[0]?.nextAction).toContain("chit_next");
	});

	test("a loop restarted in place still sorts newest by its new startedAtMs", () => {
		// Map#set on an existing key keeps the original insertion slot, so a plain
		// reverse-of-insertion would misorder a force-restarted loop. Sorting by
		// startedAtMs fixes that: re-adding loop-a with a later start moves it first.
		const status = buildStatus(
			controllerOf(
				[],
				[fakeSession("loop-a", 0), fakeSession("loop-b", 1), fakeSession("loop-a", 2)],
			),
			emptyAuditStore(),
			emptyJobStore(),
			5,
			NOW,
		);

		expect(status.active.loops.map((l) => l.run_id)).toEqual(["loop-a", "loop-b"]);
	});

	test("recent_limit of 0 returns no recent runs", () => {
		const status = buildStatus(emptyController(), emptyAuditStore(), emptyJobStore(), 0, NOW);
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
		const status = buildStatus(
			controllerOf([fakeRun("r1", { startedAtMs: 0 })]),
			throwingStore,
			emptyJobStore(),
			5,
			NOW,
		);

		expect(status.active.runs.map((r) => r.run_id)).toEqual(["r1"]);
		expect(status.recent).toEqual([]);
	});

	test("publicRunSummary presents audit_ref (a receipt handle, not run_id) and drops loopId", () => {
		const r = publicRunSummary({
			runId: "audit-1",
			manifestId: "m",
			surface: "mcp",
			loopId: "internal-loop",
			iteration: 2,
			status: "converged",
			stepCount: 4,
		} as unknown as Parameters<typeof publicRunSummary>[0]);
		expect(r.audit_ref).toBe("audit-1");
		const asRec = r as unknown as Record<string, unknown>;
		expect(asRec.run_id).toBeUndefined(); // an audit receipt is NOT addressed by a control run_id
		expect(asRec.loopId).toBeUndefined();
		expect(asRec.runId).toBeUndefined(); // the camelCase id is not surfaced either
		expect(r.iteration).toBe(2); // an informational number, not a handle, survives
	});

	test("publicTimeline strips the per-event runId and loopId, keeps the rest", () => {
		const out = publicTimeline([
			{ type: "run.started", runId: "r1", loopId: "internal-loop", manifestId: "m" },
			{ type: "step.started", runId: "r1", stepId: "implement" },
		]);
		const json = JSON.stringify(out);
		expect(json).not.toContain("runId");
		expect(json).not.toContain("loopId");
		expect((out[0] as Record<string, unknown>).manifestId).toBe("m"); // metadata survives
		expect((out[0] as Record<string, unknown>).type).toBe("run.started"); // discriminant survives
		expect((out[1] as Record<string, unknown>).stepId).toBe("implement"); // step id is fine
	});
});

describe("needsDecisionNextAction branches by verification source + rollup", () => {
	test("chit + failed -> fix the failed checks and run chit_next", () => {
		const m = needsDecisionNextAction("R1", "failed", "chit");
		expect(m).toContain("required checks failed");
		expect(m).toContain("run chit_next");
		expect(m).toContain('chit_trace "R1"');
		expect(m).not.toContain("checksRun"); // never lead with reviewer prose when chit ran
	});

	test("chit + blocked -> environment/tooling decision", () => {
		const m = needsDecisionNextAction("R1", "blocked", "chit");
		expect(m).toContain("could not run required checks");
		expect(m).toContain("environment/tooling");
	});

	test("chit + not_run -> required checks did not run, decide manually", () => {
		const m = needsDecisionNextAction("R1", "not_run", "chit");
		expect(m).toContain("required checks did not run");
		expect(m).toContain("decide manually");
	});

	test("reviewer + not-passed -> inspect the reviewer's checks", () => {
		const m = needsDecisionNextAction("R1", "failed", "reviewer");
		expect(m).toContain("reviewer-reported verification did not pass");
		expect(m).toContain("reviewer's checks");
	});

	test("absent fields -> generic fallback wording", () => {
		const m = needsDecisionNextAction("R1");
		expect(m).toContain("the reviewer returned proceed but verification did not pass");
	});
});
