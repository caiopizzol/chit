import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopVerdict, RequiredCheck } from "@chit-run/core";
import type { ConvergeExecute } from "../cli/converge.ts";
import * as convergeMod from "../cli/converge.ts";
import { readLoop, startLoop } from "../loops/log-store.ts";
import { MAX_LIVE_EVENTS } from "../runtime/live-events.ts";
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

	test("re-persists the worker-resolved provenance over the enqueue snapshot", async () => {
		// The detached worker rebuilds the run from the CURRENT config, so what it resolves -- not the
		// enqueue snapshot -- is what actually runs and gets audited. The job record must reflect that,
		// so chit_status / chit_trace never report a stale enqueue snapshot after a config edit.
		const enqueueSnapshot = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-sonnet-OLD" },
			},
		};
		const resolvedSnapshot = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-opus-NEW", envKeys: ["ANTHROPIC_API_KEY"] },
			},
		};
		seedJob({ participants: enqueueSnapshot });
		await runJobWorker("j1", {
			jobStore: store,
			resolveExecute: () => ({
				ok: true as const,
				execute: fakeExecute([{ verdict: "proceed" }]),
				loopSteps: { implementStep: "implement", reviewStep: "review" },
				participants: resolvedSnapshot,
			}),
			installSignalHandlers: false,
			heartbeatMs: 1_000_000,
			now: () => 1000,
		});
		const job = store.get("j1") as LoopJobRecord | undefined;
		// The job now carries what the worker resolved, not the enqueue placeholder.
		expect(job?.participants).toEqual(resolvedSnapshot);
		// Redaction holds across the re-persist: only env key names, never values.
		expect(JSON.stringify(job?.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});

	test("a resolver that omits provenance leaves the enqueue snapshot intact", async () => {
		// An injected fake (or a legacy path) may not carry participants; the job then keeps the
		// enqueue snapshot rather than losing provenance.
		const enqueueSnapshot = {
			impl: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope" as const,
				permissions: { filesystem: "write" as const },
				enforcesReadOnly: false,
				config: { model: "claude-opus" },
			},
		};
		seedJob({ participants: enqueueSnapshot });
		await runJobWorker("j1", runDeps(fakeExecute([{ verdict: "proceed" }])));
		expect((store.get("j1") as LoopJobRecord | undefined)?.participants).toEqual(enqueueSnapshot);
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

	test("the worker forwards the job's persisted callTimeoutMs into prepareConvergeExecute", async () => {
		// The override never survives outside the job record, so the DETACHED worker must
		// re-apply job.callTimeoutMs when it rebuilds the run in its own process. Exercise the
		// REAL defaultResolveExecute (no resolveExecute injection) and intercept the chokepoint
		// to read the value it was handed -- the spy also returns a fake execute so no real
		// adapter spawns. A fresh empty config dir keeps loadConfig on the built-in registry.
		const savedCfg = process.env.XDG_CONFIG_HOME;
		const cfgHome = mkdtempSync(join(tmpdir(), "chit-worker-cfg-"));
		mkdirSync(join(cfgHome, "chit"), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgHome;
		const spy = spyOn(convergeMod, "prepareConvergeExecute").mockReturnValue({
			ok: true,
			execute: fakeExecute([{ verdict: "proceed" }]),
			loopSteps: { implementStep: "implement", reviewStep: "review" },
			participants: {},
			warnings: [],
		});
		try {
			seedJob({ callTimeoutMs: 234_000 });
			await runJobWorker("j1", {
				jobStore: store,
				installSignalHandlers: false,
				heartbeatMs: 1_000_000,
				now: () => 1000,
			});
			// prepareConvergeExecute(raw, registry, scope, cwd, allowUnenforced, roles, callTimeoutMs)
			expect(spy.mock.calls.at(0)?.[6]).toBe(234_000);
			expect(store.get("j1")?.state).toBe("completed");
		} finally {
			spy.mockRestore();
			if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = savedCfg;
			rmSync(cfgHome, { recursive: true, force: true });
		}
	});

	test("an isolated loop worker loads repo config from the launching checkout", async () => {
		// The worker runs in job.cwd (the managed worktree), but repo config is an
		// operator-facing file in the checkout that launched the run. If the worker
		// discovers config from job.cwd, uncommitted chit.config.json edits vanish.
		const savedCfg = process.env.XDG_CONFIG_HOME;
		const cfgHome = mkdtempSync(join(tmpdir(), "chit-worker-cfg-"));
		const callerCheckout = mkdtempSync(join(tmpdir(), "chit-worker-caller-"));
		mkdirSync(join(cfgHome, "chit"), { recursive: true });
		writeFileSync(
			join(callerCheckout, "chit.config.json"),
			JSON.stringify({
				roles: {
					reviewer: { instructions: "From caller checkout.", session: "per_scope" },
				},
			}),
		);
		process.env.XDG_CONFIG_HOME = cfgHome;
		const spy = spyOn(convergeMod, "prepareConvergeExecute").mockReturnValue({
			ok: true,
			execute: fakeExecute([{ verdict: "proceed" }]),
			loopSteps: { implementStep: "implement", reviewStep: "review" },
			participants: {},
			warnings: [],
		});
		try {
			seedJob({
				worktreePath: cwd,
				branch: "chit-run/j1/s",
				baseSha: "abc123",
				repo: callerCheckout,
				callerCheckout,
			});
			await runJobWorker("j1", {
				jobStore: store,
				installSignalHandlers: false,
				heartbeatMs: 1_000_000,
				now: () => 1000,
			});
			const rolesArg = spy.mock.calls.at(0)?.[5] as
				| Record<string, { instructions?: string }>
				| undefined;
			expect(rolesArg?.reviewer?.instructions).toBe("From caller checkout.");
			expect(store.get("j1")?.state).toBe("completed");
		} finally {
			spy.mockRestore();
			if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = savedCfg;
			rmSync(cfgHome, { recursive: true, force: true });
			rmSync(callerCheckout, { recursive: true, force: true });
		}
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

// The persisted live-event tail: populated from trace + adapter events, written
// only on existing writes (phase changes, heartbeats, iteration bookkeeping),
// capped, and cleared at a terminal state. Mid-run assertions read the store
// from INSIDE the fake execute, since the worker always settles terminal (which
// clears the tail) before runJobWorker returns.
describe("background live event tail", () => {
	// A successful run whose review carries the given verdict (fakeExecute's shape),
	// for executes that emit live events through ctx before settling.
	function reviewResult(verdict: LoopVerdict) {
		const review = `looks fine\n\`\`\`json\n${JSON.stringify({
			verdict,
			findingCount: 0,
			checks: [{ command: "tests", status: "passed" }],
			checksRun: "tests",
			risk: "none",
		})}\n\`\`\``;
		return {
			ok: true as const,
			output: "## converge iteration",
			outputs: { implement: "did the slice", review },
			trace: [],
			auditRunId: "run-1",
		};
	}

	test("trace + adapter events populate the tail; persistence rides existing writes, never per adapter event", async () => {
		seedJob();
		let afterAdapterEvent: unknown;
		let afterTrace: unknown;
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctx?.onAdapterEvent?.({
				stepId: "implement",
				participantId: "impl",
				agentId: "claude",
				type: "tool_use",
			});
			afterAdapterEvent = store.get("j1")?.recentEvents;
			ctx?.onTrace?.({
				type: "step.started",
				stepId: "implement",
				kind: "call",
				prompt: "SECRET-PROMPT",
			});
			afterTrace = store.get("j1")?.recentEvents;
			return reviewResult("proceed");
		};
		await runJobWorker("j1", runDeps(execute));
		// An adapter event alone stays in memory -- no per-event disk write.
		expect(afterAdapterEvent).toBeUndefined();
		// The implement step.started rides the existing phase write, flushing the
		// whole tail (the adapter event included, in arrival order).
		expect(afterTrace).toEqual([
			expect.objectContaining({ kind: "adapter.event", label: "tool_use", stepId: "implement" }),
			expect.objectContaining({ kind: "step.started", stepId: "implement" }),
		]);
		// Summaries are structural facts only; the trace payload never lands on disk.
		expect(JSON.stringify(afterTrace)).not.toContain("SECRET-PROMPT");
	});

	test("the tail keeps only the newest MAX_LIVE_EVENTS", async () => {
		seedJob();
		let persisted: unknown;
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			for (let n = 1; n <= MAX_LIVE_EVENTS + 5; n++) {
				ctx?.onAdapterEvent?.({
					stepId: "implement",
					participantId: "impl",
					agentId: "claude",
					type: `evt-${n}`,
				});
			}
			ctx?.onTrace?.({ type: "step.started", stepId: "review", kind: "call" });
			persisted = store.get("j1")?.recentEvents;
			return reviewResult("proceed");
		};
		await runJobWorker("j1", runDeps(execute));
		const tail = persisted as Array<{ label: string; kind: string }>;
		expect(tail).toHaveLength(MAX_LIVE_EVENTS);
		// 55 adapter events + 1 trace appended; the oldest 6 rolled off.
		expect(tail[0]?.label).toBe("evt-7");
		expect(tail.at(-1)).toMatchObject({ kind: "step.started" });
	});

	test("the tail persists on iteration bookkeeping and rolls across iterations", async () => {
		seedJob();
		let iter = 0;
		let seenAtIterationTwoStart: unknown;
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			iter++;
			// Iteration 2 begins AFTER iteration 1's recording write and iteration 2's
			// own bookkeeping write; both carry the tail, so iteration 1's event is
			// already durable here even though no phase/heartbeat write followed it.
			if (iter === 2) seenAtIterationTwoStart = store.get("j1")?.recentEvents;
			ctx?.onAdapterEvent?.({
				stepId: "implement",
				participantId: "impl",
				agentId: "claude",
				type: `iter-${iter}`,
			});
			return reviewResult(iter === 1 ? "revise" : "proceed");
		};
		await runJobWorker("j1", runDeps(execute));
		expect(seenAtIterationTwoStart).toEqual([
			expect.objectContaining({ kind: "adapter.event", label: "iter-1" }),
		]);
	});

	test("a terminal write clears the tail (terminal jobs are not in the live tower)", async () => {
		seedJob();
		const execute: ConvergeExecute = async (_inputs, ctx) => {
			ctx?.onTrace?.({ type: "step.started", stepId: "implement", kind: "call" });
			return reviewResult("proceed");
		};
		await runJobWorker("j1", runDeps(execute));
		const job = store.get("j1");
		expect(job?.state).toBe("completed");
		expect(job?.recentEvents).toBeUndefined();
		// Cleared in the durable FILE, not just the read view.
		const onDisk = readFileSync(join(stateDir, "chit", "jobs", "j1.json"), "utf-8");
		expect(onDisk).not.toContain("recentEvents");
	});

	test("a legacy record never gains the field when no events arrive", async () => {
		seedJob(); // seeded without recentEvents, like every pre-field record
		let midRun: unknown;
		const execute: ConvergeExecute = async () => {
			midRun = store.get("j1");
			return reviewResult("proceed");
		};
		await runJobWorker("j1", runDeps(execute));
		// No events -> tailPatch stays empty -> no write ever introduces the field.
		expect(midRun !== undefined && "recentEvents" in (midRun as object)).toBe(false);
		expect(store.get("j1")?.recentEvents).toBeUndefined();
	});

	test("one-shot: trace events feed the tail and the heartbeat flushes it", async () => {
		seedOneShot();
		let persisted: unknown;
		await runJobWorker("os1", {
			jobStore: store,
			runOnce: async (_job, opts) => {
				opts.onTrace?.({ type: "step.started", stepId: "build", kind: "call" });
				// A one-shot run has no phase transitions mid-run; only the heartbeat
				// (10ms here) can flush the tail while the manifest runs.
				await new Promise((r) => setTimeout(r, 100));
				persisted = store.get("os1")?.recentEvents;
				return { ok: true, auditRunId: "aud-1" };
			},
			installSignalHandlers: false,
			heartbeatMs: 10,
			now: () => 1000,
		});
		expect(persisted).toEqual([expect.objectContaining({ kind: "step.started", stepId: "build" })]);
		expect(store.get("os1")?.recentEvents).toBeUndefined(); // cleared at terminal
	});
});

describe("required checks via the background worker (chit-executed)", () => {
	const PASS: RequiredCheck = { command: "true", args: [] };
	const FAIL: RequiredCheck = { command: "false", args: [] };
	const BLOCK: RequiredCheck = { command: "sleep", args: ["5"], timeoutMs: 50 };

	const depsWithChecks = (
		execute: ConvergeExecute,
		requiredChecks: RequiredCheck[],
	): JobWorkerDeps => ({
		jobStore: store,
		resolveExecute: () => ({
			ok: true as const,
			execute,
			loopSteps: { implementStep: "implement", reviewStep: "review", requiredChecks },
		}),
		installSignalHandlers: false,
		heartbeatMs: 1_000_000,
		now: () => 1000,
	});

	const firstIter = () => readLoop(cwd, "j1").find((r) => r.type === "iteration");

	test("proceed + passing checks -> completed converged via chit", async () => {
		seedJob();
		await runJobWorker("j1", depsWithChecks(fakeExecute([{ verdict: "proceed" }]), [PASS]));
		expect(store.get("j1")).toMatchObject({
			state: "completed",
			stopStatus: "converged",
			lastVerification: "passed", // cached on the job for status views
			lastVerificationSource: "chit",
		});
		expect(firstIter()).toMatchObject({ verification: "passed", verificationSource: "chit" });
	});

	test("proceed + a failed check -> revise loop to max-iterations (decision revise recorded)", async () => {
		seedJob({ maxIterations: 1 });
		await runJobWorker("j1", depsWithChecks(fakeExecute([{ verdict: "proceed" }]), [FAIL]));
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "max-iterations" });
		expect(firstIter()).toMatchObject({
			decision: "revise",
			verification: "failed",
			verificationSource: "chit",
		});
	});

	test("proceed + a blocked-only check -> needs-decision", async () => {
		seedJob();
		await runJobWorker("j1", depsWithChecks(fakeExecute([{ verdict: "proceed" }]), [BLOCK]));
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "needs-decision" });
	});

	test("the job's snapshotted requiredChecks beat the manifest fallback", async () => {
		// The job carries a FAILING snapshot (the effective checks persisted at enqueue);
		// the manifest (loopSteps) would pass. The snapshot wins -> revise ->
		// max-iterations. The worker's manifest fallback is only for legacy jobs without
		// the field; a job that has it always runs exactly what was snapshotted.
		seedJob({ maxIterations: 1, requiredChecks: [FAIL] });
		await runJobWorker("j1", depsWithChecks(fakeExecute([{ verdict: "proceed" }]), [PASS]));
		expect(store.get("j1")).toMatchObject({ state: "completed", stopStatus: "max-iterations" });
		expect(readLoop(cwd, "j1").find((r) => r.type === "iteration")).toMatchObject({
			verification: "failed", // the job's FAIL won, not the manifest's PASS
			verificationSource: "chit",
		});
	});

	test("an empty ([]) snapshot stays reviewer-sourced, never falling back to the manifest", async () => {
		// [] is the snapshot for "no checks declared at launch" (launchConvergeJob persists
		// it), NOT a legacy gap. The worker must honor it: run no chit checks and keep the
		// reviewer's verification. The manifest's FAIL must never run -- if the worker fell
		// back, the iteration would be chit-sourced and failed instead of reviewer-sourced.
		seedJob({ maxIterations: 1, requiredChecks: [] });
		await runJobWorker("j1", depsWithChecks(fakeExecute([{ verdict: "proceed" }]), [FAIL]));
		expect(firstIter()).toMatchObject({ verificationSource: "reviewer" });
	});
});
