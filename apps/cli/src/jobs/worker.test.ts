import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopVerdict } from "@chit-run/core";
import type { ConvergeExecute } from "../cli/converge.ts";
import { readLoop, startLoop } from "../loops/log-store.ts";
import { JobStore } from "./store.ts";
import type { LoopJobRecord, OneShotJobRecord } from "./types.ts";
import { type JobWorkerDeps, runJobWorker } from "./worker.ts";

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
	outcomes: Array<{
		verdict?: LoopVerdict;
		fail?: string;
		auditRunId?: string;
		checks?: unknown[];
	}>,
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
			// A passing check so a proceed converges under the verification gate; an
			// outcome can override with a failing/empty check to exercise the gate.
			checks: o?.checks ?? [{ command: "tests", status: "passed" }],
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

function seedJob(over: Partial<LoopJobRecord> = {}): LoopJobRecord {
	const loopId = over.loopId ?? "j1";
	// chit_converge_run reserves the loop (startLoop) before spawning the worker.
	startLoop(cwd, { scope: "s", task: "t", maxIterations: over.maxIterations ?? 3, loopId });
	const job = {
		runId: "j1",
		policy: "loop",
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
	} as LoopJobRecord;
	store.create(job);
	return job;
}

const runDeps = (execute: ConvergeExecute) => ({
	jobStore: store,
	resolveExecute: () => ({
		ok: true as const,
		execute,
		loopSteps: { implementStep: "implement", reviewStep: "review" },
	}),
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

	test("reviewer proceed but a failing check -> completed with needs-decision (honest reason)", async () => {
		seedJob();
		await runJobWorker(
			"j1",
			runDeps(
				fakeExecute([
					{
						verdict: "proceed",
						checks: [{ command: "tests", status: "failed", reason: "1 failing" }],
					},
				]),
			),
		);
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "needs-decision" });
		const stop = readLoop(cwd, "j1").at(-1);
		expect(stop).toMatchObject({ type: "stop", status: "needs-decision" });
		// The worker is a loop driver that had the same binary mislabel as the MCP path:
		// a needs-decision stop must NOT read "reviewer returned block" (the reviewer
		// returned proceed). Its wording is now the shared, honest gate text.
		if (stop?.type === "stop") {
			expect(stop.reason).toContain("verification did not pass");
			expect(stop.reason).not.toContain("returned block");
		}
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

	test("a THROWING resolveExecute does not leave the job stuck running", async () => {
		// resolveExecute is contracted to RETURN an ExecuteResolution; runLoopJob has
		// no catch around it, so if it threw (e.g. defaultResolveExecute's loadConfig
		// on a malformed config.json) the job would be stuck running -> later stale
		// instead of failed. defaultResolveExecute now catches the load, but guard the
		// invariant directly: even a thrown resolveExecute must not leave it running.
		seedJob();
		await runJobWorker("j1", {
			jobStore: store,
			resolveExecute: () => {
				throw new Error("resolve exploded");
			},
			installSignalHandlers: false,
			now: () => 1000,
		});
		expect(store.get("j1")?.state).not.toBe("running");
	});

	test("a malformed config.json -> the loop job closes failed (real loadConfig path)", async () => {
		// Exercise the DEFAULT resolveExecute (no injection): a malformed config.json
		// makes loadConfig throw, which must surface as a clean failed job + blocked
		// loop, not a job stuck running. The job uses the embedded default manifest
		// (no manifestPath), so the only failure is the config load.
		const savedCfg = process.env.XDG_CONFIG_HOME;
		const cfgHome = mkdtempSync(join(tmpdir(), "chit-worker-cfg-"));
		mkdirSync(join(cfgHome, "chit"), { recursive: true });
		writeFileSync(join(cfgHome, "chit", "config.json"), "{ not valid json");
		process.env.XDG_CONFIG_HOME = cfgHome;
		try {
			seedJob();
			await runJobWorker("j1", {
				jobStore: store,
				installSignalHandlers: false,
				now: () => 1000,
			});
			const job = store.get("j1");
			expect(job?.state).toBe("failed");
			expect(job?.failure).toMatch(/could not load config/);
			expect(readLoop(cwd, "j1").at(-1)).toMatchObject({ type: "stop", status: "blocked" });
		} finally {
			if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = savedCfg;
			rmSync(cfgHome, { recursive: true, force: true });
		}
	});

	test("a non-queued job is left untouched (idempotent against double spawn)", async () => {
		seedJob({ state: "running" });
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		// still running, no iterations appended
		expect(store.get("j1")?.state).toBe("running");
		expect(readLoop(cwd, "j1").filter((r) => r.type === "iteration")).toHaveLength(0);
	});
});

describe("background worker: non-default loop policy steps (Stage 2)", () => {
	test("reads outputs + check duration from the resolved policy steps, not literals", async () => {
		seedJob();
		const review = `looks fine\n\`\`\`json\n${JSON.stringify({
			verdict: "proceed",
			findingCount: 0,
			checks: [{ command: "tests", status: "passed" }],
			checksRun: "tests",
			risk: "none",
		})}\n\`\`\``;
		// The run reports under build/check; a worker hardwired to implement/review
		// would misread this as an empty review (fail-safe block) + "(no summary)".
		const execute: ConvergeExecute = async () => ({
			ok: true,
			output: "",
			outputs: { build: "built the slice", check: review },
			trace: [{ type: "step.completed", stepId: "check", output: review, durationMs: 555 }],
		});
		await runJobWorker("j1", {
			jobStore: store,
			resolveExecute: () => ({
				ok: true as const,
				execute,
				loopSteps: { implementStep: "build", reviewStep: "check" },
			}),
			installSignalHandlers: false,
			heartbeatMs: 1_000_000,
			now: () => 1000,
		});
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "converged" });
		const it = readLoop(cwd, "j1").find((r) => r.type === "iteration");
		if (it?.type !== "iteration") throw new Error("no iteration record");
		expect(it.implementSummary).toContain("built the slice");
		expect(it.checkDurationMs).toBe(555);
	});
});

// A one-shot background job: a manifest run once to completion, no loop. Unlike a
// loop job it reserves no loop (no startLoop) and the worker drives it via the
// injected runOnce instead of resolveExecute.
function seedOneShot(over: Partial<OneShotJobRecord> = {}): OneShotJobRecord {
	const job = {
		runId: "os1",
		policy: "one-shot",
		repoKey: "k",
		cwd,
		manifestPath: "/does/not/matter.json", // runOnce is injected, so never read
		manifestId: "m",
		inputs: {},
		audit: true,
		allowUnenforced: false,
		state: "queued",
		createdAt: "2026-06-01T10:00:00.000Z",
		auditRefs: [],
		...over,
	} as OneShotJobRecord;
	store.create(job);
	return job;
}

const oneShotDeps = (runOnce: NonNullable<JobWorkerDeps["runOnce"]>): JobWorkerDeps => ({
	jobStore: store,
	runOnce,
	installSignalHandlers: false,
	heartbeatMs: 1_000_000,
	now: () => 1000,
});

describe("background one-shot worker", () => {
	test("success -> completed, records the single audit ref", async () => {
		seedOneShot();
		let seenInputs: unknown;
		await runJobWorker(
			"os1",
			oneShotDeps(async (job) => {
				seenInputs = job.inputs;
				return { ok: true, output: "done", auditRunId: "aud-1" };
			}),
		);
		const job = store.get("os1");
		expect(job).toMatchObject({ state: "completed", policy: "one-shot", auditRefs: ["aud-1"] });
		expect(job?.phase).toBeUndefined(); // terminal: no live phase
		expect(seenInputs).toEqual({}); // the persisted inputs are passed through
	});

	test("failure preserves the audit ref it produced", async () => {
		seedOneShot();
		await runJobWorker(
			"os1",
			oneShotDeps(async () => ({
				ok: false,
				error: "boom",
				failedStep: "build",
				auditRunId: "aud-x",
			})),
		);
		expect(store.get("os1")).toMatchObject({
			state: "failed",
			failure: "boom",
			auditRefs: ["aud-x"],
		});
	});

	test("a persisted cancel before work -> cancelled, never runs", async () => {
		seedOneShot();
		store.update("os1", (c) => ({ ...c, cancelRequestedAt: "2026-06-01T10:05:00.000Z" }));
		let called = false;
		await runJobWorker(
			"os1",
			oneShotDeps(async () => {
				called = true;
				return { ok: true };
			}),
		);
		expect(store.get("os1")?.state).toBe("cancelled");
		expect(called).toBe(false); // the run is never started once a cancel is pending
	});

	test("never touches the loop lock (a one-shot run has no loop)", async () => {
		seedOneShot();
		// If runOneShotJob acquired a loop lock, this would throw and fail the run.
		(store as unknown as { loopLockPath: () => string }).loopLockPath = () => {
			throw new Error("one-shot must not acquire a loop lock");
		};
		await runJobWorker(
			"os1",
			oneShotDeps(async () => ({ ok: true, auditRunId: "aud-1" })),
		);
		expect(store.get("os1")?.state).toBe("completed");
	});

	test("a cancel persisted during the run -> cancelled even if the run reports ok", async () => {
		seedOneShot();
		await runJobWorker(
			"os1",
			oneShotDeps(async () => {
				// A concurrent cancel lands mid-run (intent persisted, no signal in tests).
				store.update("os1", (c) => ({ ...c, cancelRequestedAt: "2026-06-01T10:05:00.000Z" }));
				return { ok: true, auditRunId: "aud-1" };
			}),
		);
		const job = store.get("os1");
		expect(job?.state).toBe("cancelled"); // intent-first: the cancel wins over ok
		expect(job?.auditRefs).toEqual(["aud-1"]); // the transcript is still preserved
	});

	test("a throw while a cancel is pending settles cancelled, not failed", async () => {
		seedOneShot();
		await runJobWorker(
			"os1",
			oneShotDeps(async () => {
				store.update("os1", (c) => ({ ...c, cancelRequestedAt: "2026-06-01T10:05:00.000Z" }));
				throw new Error("aborted mid-run");
			}),
		);
		expect(store.get("os1")?.state).toBe("cancelled");
	});

	test("a double-spawned worker cannot run the manifest twice (claim)", async () => {
		seedOneShot();
		let runs = 0;
		const dep = oneShotDeps(async () => {
			runs++;
			return { ok: true, auditRunId: `aud-${runs}` };
		});
		await runJobWorker("os1", dep); // first worker claims queued->running and runs
		await runJobWorker("os1", dep); // second sees non-queued, never runs
		expect(runs).toBe(1);
		expect(store.get("os1")?.state).toBe("completed");
	});
});
