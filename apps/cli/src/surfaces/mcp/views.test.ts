import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStoreError } from "../../audit/store.ts";
import { realGit } from "../../batches/worktree.ts";
import { LockError } from "../../jobs/lock.ts";
import { JobStoreError } from "../../jobs/store.ts";
import type { LoopJobRecord } from "../../jobs/types.ts";
import { LoopStoreError } from "../../loops/log-store.ts";
import { type ConvergeSession, cancelConverge, type NextResult } from "./converge-engine.ts";
import type { Run } from "./engine.ts";
import {
	backgroundRunView,
	loopRunView,
	loopStatusLine,
	oneShotRunView,
	publicLoopRecords,
	safeMcpError,
} from "./server.ts";

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
function job(over: Partial<LoopJobRecord> = {}): LoopJobRecord {
	// A live running job by default: this process's pid + a fresh heartbeat, so
	// isStale() is false and display is "running" (not derived-stale).
	return {
		runId: "j1",
		policy: "loop",
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
	} as LoopJobRecord;
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

	test("a needs-decision loop view explains verification did not pass (not a clean stop)", () => {
		const v = loopRunView(loopSession({ loopId: "loop-nd", terminalStatus: "needs-decision" }));
		expect(v.status).toBe("needs-decision");
		expect(v.cancellable).toBe(false);
		expect(v.nextAction).toContain("verification did not pass");
		expect(v.nextAction).toContain('chit_trace "loop-nd"');
		expect(v.nextAction).not.toContain("converged");
		expectNoLeakage(v);
	});

	test("a managed-worktree loop view surfaces the worktree + says the caller checkout was not edited (#85)", () => {
		const v = loopRunView(
			loopSession({
				terminalStatus: "converged",
				worktreePath: "/wt/run-x/owner",
				branch: "chit-run/run-x/owner",
				baseSha: "basesha",
			}),
		);
		expect(v.worktreePath).toBe("/wt/run-x/owner");
		expect(v.branch).toBe("chit-run/run-x/owner");
		expect(v.baseSha).toBe("basesha");
		expect(v.callerCheckoutEdited).toBe(false);
		// The terminal nextAction points at the worktree, says the checkout was untouched, and
		// PREFERS chit_cleanup (resolvable run) -- with the manual git commands only as fallback.
		expect(v.nextAction).toContain("/wt/run-x/owner");
		expect(v.nextAction).toContain("checkout was not edited");
		expect(v.nextAction).toContain("chit_cleanup");
		expect(v.nextAction).toContain("confirm: true");
		expect(v.nextAction).toContain("git worktree remove /wt/run-x/owner"); // fallback still present
		expect(v.nextAction).toContain("git branch -D chit-run/run-x/owner");
	});

	test("a needs-decision (failed-ish) managed-worktree loop view also prefers chit_cleanup", () => {
		const v = loopRunView(
			loopSession({
				loopId: "loop-nd-wt",
				terminalStatus: "needs-decision",
				worktreePath: "/wt/loop-nd-wt/owner",
				branch: "chit-run/loop-nd-wt/owner",
				baseSha: "basesha",
			}),
		);
		expect(v.nextAction).toContain("chit_cleanup");
		expect(v.nextAction).toContain("verification did not pass"); // the needs-decision reason is still there
	});

	test("an ACTIVE managed-worktree loop view does NOT suggest cleanup (only terminal states do)", () => {
		const v = loopRunView(
			loopSession({ active: new AbortController(), worktreePath: "/wt/run-a/owner" }),
		);
		expect(v.worktreePath).toBe("/wt/run-a/owner"); // surfaced...
		expect(v.nextAction).not.toContain("git worktree remove"); // ...but no retire-while-running
		expect(v.nextAction).toContain("chit_cancel");
	});

	test("an in_place loop view has no worktree fields and no worktree hint", () => {
		// in_place runs in the caller checkout -> prepareRunWorkspace returns no worktree, so
		// the session carries none; the view must not claim a managed worktree or callerCheckoutEdited.
		const v = loopRunView(loopSession({ terminalStatus: "converged" }));
		expect(v.worktreePath).toBeUndefined();
		expect(v.callerCheckoutEdited).toBeUndefined();
		expect(v.nextAction).not.toContain("managed worktree");
		expect(v.nextAction).not.toContain("chit_cleanup"); // nothing to clean -> no cleanup guidance
	});

	test("background view is keyed by run_id (== job id), drops the job/loop handles", () => {
		const v = backgroundRunView(job({ runId: "bg-7", auditRefs: ["aud-1"] }));
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
			job({ runId: "bg-9", state: "completed", stopStatus: "converged" }),
		);
		expect(v.display).toBe("completed");
		expect(v.nextAction).toContain("chit_trace");
		expectNoLeakage(v);
	});

	test("a managed-worktree background view surfaces the worktree + the not-edited hint (#85)", () => {
		const v = backgroundRunView(
			job({
				runId: "bg-wt",
				state: "completed",
				stopStatus: "converged",
				worktreePath: "/wt/bg-wt/owner",
				branch: "chit-run/bg-wt/owner",
				baseSha: "basesha",
			}),
		) as Record<string, unknown>;
		expect(v.worktreePath).toBe("/wt/bg-wt/owner");
		expect(v.branch).toBe("chit-run/bg-wt/owner");
		expect(v.callerCheckoutEdited).toBe(false);
		expect(v.nextAction).toContain("/wt/bg-wt/owner");
		expect(v.nextAction).toContain("checkout was not edited");
		expect(v.nextAction).toContain("chit_cleanup"); // prefers the tool, keyed by this run_id
		expectNoLeakage(v);
	});

	test("a needs-decision background view explains verification did not pass", () => {
		const v = backgroundRunView(
			job({ runId: "bg-nd", state: "completed", stopStatus: "needs-decision" }),
		);
		expect(v.display).toBe("completed");
		expect(v.nextAction).toContain("verification did not pass");
		expect(v.nextAction).toContain('chit_trace "bg-nd"');
		expectNoLeakage(v);
	});

	test("a loop view surfaces the latest verification + source, and the nextAction branches on them", () => {
		const v = loopRunView(
			loopSession({
				terminalStatus: "needs-decision",
				lastVerification: "failed",
				lastVerificationSource: "chit",
			}),
		);
		expect(v.lastVerification).toBe("failed");
		expect(v.lastVerificationSource).toBe("chit");
		// The view passes the cached fields to needsDecisionNextAction -> the chit-failed
		// branch (not the generic wording).
		expect(v.nextAction).toContain("required checks failed");
	});

	test("a terminal loop view carries the terminal receipt: elapsedMs + stopReason", () => {
		// endedAtMs + stopReason are set in lockstep with terminalStatus (the in-memory
		// mirror of the durable stop record), so a single-run view reports a stopped run's
		// timing and WHY it stopped straight from memory: elapsedMs = endedAtMs - startedAtMs.
		const v = loopRunView(
			loopSession({
				terminalStatus: "max-iterations",
				startedAtMs: 1_000,
				endedAtMs: 91_000,
				stopReason: "reached max iterations (3) without converging",
			}),
		) as Record<string, unknown>;
		expect(v.elapsedMs).toBe(90_000); // endedAtMs - startedAtMs, from the mirror
		expect(v.stopReason).toBe("reached max iterations (3) without converging");
	});

	test("an open loop view has no terminal receipt (elapsedMs/stopReason absent)", () => {
		// While the loop is open the mirror is unset, so the receipt fields must not appear
		// (no premature elapsed/stop reason).
		const v = loopRunView(loopSession({ startedAtMs: 1_000 })) as Record<string, unknown>;
		expect(v.elapsedMs).toBeUndefined();
		expect(v.stopReason).toBeUndefined();
	});

	test("a background view surfaces the latest verification + its source", () => {
		// backgroundRunView returns a loop|one-shot union; this is a loop job, so read the
		// loop-only fields through a cast.
		const v = backgroundRunView(
			job({
				state: "completed",
				stopStatus: "needs-decision",
				lastVerification: "blocked",
				lastVerificationSource: "chit",
			}),
		) as Record<string, unknown>;
		expect(v.lastVerification).toBe("blocked");
		expect(v.lastVerificationSource).toBe("chit");
	});

	test("loop trace records are sanitized: the header drops loopId/repoKey, no leak", () => {
		// chit_trace returns the loop log; its header record carries the internal
		// loopId + repoKey. publicLoopRecords strips those, keeping iteration/stop
		// records (which carry no ids) intact.
		const raw = [
			{
				type: "loop",
				schema: 1,
				loopId: "internal-loop-key",
				scope: "sc",
				task: "t",
				repo: "/repo",
				repoKey: "deadbeef",
				startedAt: "2026-06-02T00:00:00.000Z",
				maxIterations: 3,
			},
			{ type: "iteration", n: 1, changedFiles: ["a.ts"], verdict: "proceed", auditRef: "aud-1" },
			{ type: "stop", status: "converged", reason: "reviewer returned proceed", iterations: 1 },
		] as unknown as Parameters<typeof publicLoopRecords>[0];
		const out = publicLoopRecords(raw);
		expectNoLeakage(out);
		const header = out[0] as Record<string, unknown>;
		expect(header.loopId).toBeUndefined();
		expect(header.repoKey).toBeUndefined();
		expect(header.task).toBe("t"); // informational fields survive
		expect(out[1]).toEqual(raw[1]); // iteration record passes through unchanged
	});

	test("publicLoopRecords preserves an iteration's checks + verification + verificationSource", () => {
		const raw = [
			{
				type: "iteration",
				n: 1,
				verdict: "proceed",
				verification: "failed",
				verificationSource: "chit",
				checks: [{ command: "bun test", status: "failed", reason: "1 failing" }],
			},
		] as unknown as Parameters<typeof publicLoopRecords>[0];
		// The gate's evidence (why a run did not converge, and whether chit ran the checks
		// or the reviewer claimed them) must reach chit_trace intact.
		expect(publicLoopRecords(raw)[0]).toEqual(raw[0]);
	});

	test("safeMcpError reduces storage errors to run-scoped text, passes others through", () => {
		// Storage-layer messages embed absolute paths + internal ids (loopId, the
		// audit run id); they must never reach an MCP error.
		expect(
			safeMcpError(new LoopStoreError('loop log at /abs/.chit/loops/L1 declares loopId "L1"')),
		).not.toMatch(/L1|loopId|\/abs/);
		expect(
			safeMcpError(new AuditStoreError('no audit log for run "r1" at /abs/audit/r1')),
		).not.toMatch(/r1|\/abs/);
		expect(safeMcpError(new JobStoreError('no run "j1"'))).not.toMatch(/j1/);
		// A LockError embeds the absolute lock path + an `rm <path>` hint; it must
		// collapse to a retryable run-scoped reason, never the path.
		expect(
			safeMcpError(
				new LockError(
					'could not acquire lock /abs/.chit/jobs/j1.lock after 4 attempts. rm "/abs/.chit/jobs/j1.lock"',
				),
			),
		).not.toMatch(/\/abs|\.lock|j1|rm /);
		// A raw node filesystem error (ErrnoException: an E* `code` + a `.path`, with the
		// absolute path in the message) is what escapes a store that did not wrap it. It
		// must be genericized, never passed through with the path.
		const fsErr = Object.assign(
			new Error("ENOENT: no such file or directory, open '/abs/.chit/loops/x/y.jsonl'"),
			{ code: "ENOENT", path: "/abs/.chit/loops/x/y.jsonl", syscall: "open" },
		);
		expect(safeMcpError(fsErr)).not.toMatch(/\/abs|\.jsonl|ENOENT/);
		// A network error has an errno code but NO `.path`; its message is caller-relevant
		// with no local path, so it passes through unchanged (not mistaken for a fs leak).
		const netErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
			code: "ECONNREFUSED",
		});
		expect(safeMcpError(netErr)).toBe("connect ECONNREFUSED 127.0.0.1:443");
		// A run-logic error (the caller's manifest/inputs) passes through unchanged.
		expect(safeMcpError(new Error("step implement failed: bad input"))).toBe(
			"step implement failed: bad input",
		);
	});
});

describe("loopStatusLine: a compact RETURNED summary an agent can audit without the live heartbeats", () => {
	// Minimal NextResult fixtures (casts), matching this file's fixture style. The
	// iteration line reads only kind/iteration/verdict/checks, so the rest is elided.
	function iterResult(over: Partial<Extract<NextResult, { kind: "iteration" }>> = {}): NextResult {
		return {
			kind: "iteration",
			iteration: 1,
			verdict: "proceed",
			checks: [],
			...over,
		} as NextResult;
	}
	const passed = (command: string) => ({ command, status: "passed" as const });
	const failed = (command: string) => ({ command, status: "failed" as const });

	test("a converged round: iteration, verdict, chit-run required-check rollup, then the stop", () => {
		const line = loopStatusLine(
			iterResult({
				iteration: 3,
				verdict: "proceed",
				checks: [passed("bun test"), passed("tsc"), passed("biome")],
			}),
			loopSession({ iteration: 3, terminalStatus: "converged", lastVerificationSource: "chit" }),
		);
		expect(line).toBe("iteration 3 · proceed · 3/3 required checks passed · converged");
	});

	test("a needs-decision round names how many required checks passed (the WHY behind the gate)", () => {
		const line = loopStatusLine(
			iterResult({
				iteration: 1,
				verdict: "proceed",
				checks: [passed("bun test"), passed("tsc"), failed("biome")],
			}),
			loopSession({
				iteration: 1,
				terminalStatus: "needs-decision",
				lastVerificationSource: "chit",
			}),
		);
		expect(line).toBe("iteration 1 · proceed · 2/3 required checks passed · needs-decision");
	});

	test("reviewer-reported checks are 'checks', not 'required checks'; an open round shows no stop", () => {
		const line = loopStatusLine(
			iterResult({ iteration: 2, verdict: "revise", checks: [passed("the tests")] }),
			// terminalStatus undefined -> the loop is still open (a revise continues).
			loopSession({ iteration: 2, lastVerificationSource: "reviewer" }),
		);
		expect(line).toBe("iteration 2 · revise · 1/1 checks passed");
	});

	test("no checks ran: the line omits the check clause (verdict + stop carry the round)", () => {
		const line = loopStatusLine(
			iterResult({ iteration: 1, verdict: "proceed", checks: [] }),
			loopSession({ iteration: 1, terminalStatus: "needs-decision" }),
		);
		expect(line).toBe("iteration 1 · proceed · needs-decision");
	});

	test("a cancelled round states the stop once (no 'cancelled · cancelled' duplicate)", () => {
		const line = loopStatusLine(
			{ kind: "cancelled", iteration: 2 } as NextResult,
			loopSession({ terminalStatus: "cancelled" }),
		);
		expect(line).toBe("iteration 2 · cancelled");
	});

	test("a failed round surfaces the actual terminal status (blocked) after 'failed'", () => {
		const line = loopStatusLine(
			{ kind: "failed", iteration: 1, failure: "manifest run failed" } as NextResult,
			loopSession({ terminalStatus: "blocked" }),
		);
		expect(line).toBe("iteration 1 · failed · blocked");
	});

	test("vocabulary matches the heartbeat lines (iteration · verdict · stop) so the two narrations read alike", () => {
		// The iterated heartbeat is `<run_id> · iteration N · <verdict>[ · <stopStatus>]`; the
		// statusLine reuses the same words + ` · ` separator (adding the check rollup the
		// heartbeat lacks), so an operator reading either sees the same shape.
		const line = loopStatusLine(
			iterResult({ iteration: 5, verdict: "proceed", checks: [] }),
			loopSession({ iteration: 5, terminalStatus: "converged" }),
		);
		expect(line.startsWith("iteration 5 · proceed")).toBe(true);
		expect(line.endsWith("· converged")).toBe(true);
	});
});

describe("loopRunView statusLine: the chit_status mirror of the chit_next line", () => {
	// Live MCP notifications never reach the calling model's transcript, so after a long
	// chit_next an agent re-reads the run via chit_status -> loopRunView. These pin that the
	// view recomposes the SAME compact line from the session mirror (the last completed
	// iteration's cached bits), and invents none before a round completes.
	const passed = (command: string) => ({ command, status: "passed" as const });
	const blocked = (command: string) => ({ command, status: "blocked" as const });

	test("a converged round surfaces the same line chit_next returned (the example shape)", () => {
		// The session as runNextIteration leaves it after a proceed + all-checks-passed round
		// that converged via chit-executed required checks: iteration/verdict/checks/source/stop
		// all set in lockstep.
		const session = loopSession({
			iteration: 1,
			lastVerdict: "proceed",
			lastVerificationSource: "chit",
			lastChecks: [passed("bun test"), passed("tsc"), passed("biome")],
			terminalStatus: "converged",
			lastStopStatus: "converged",
		});
		const v = loopRunView(session) as Record<string, unknown>;
		expect(v.statusLine).toBe("iteration 1 · proceed · 3/3 required checks passed · converged");
		// ...and it equals what chit_next composes from the transient result for that round,
		// so the live and audit surfaces cannot drift.
		const result = {
			kind: "iteration",
			iteration: 1,
			verdict: "proceed",
			checks: [passed("bun test"), passed("tsc"), passed("biome")],
		} as NextResult;
		expect(v.statusLine).toBe(loopStatusLine(result, session));
		expectNoLeakage(v);
	});

	test("a needs-decision round names how many required checks passed (the gate's WHY)", () => {
		// Reachable: proceed but a check could only be BLOCKED (e.g. a read-only sandbox) ->
		// verification blocked -> needs-decision; 2 of 3 passed.
		const v = loopRunView(
			loopSession({
				iteration: 1,
				lastVerdict: "proceed",
				lastVerificationSource: "chit",
				lastChecks: [passed("bun test"), passed("tsc"), blocked("git push --dry-run")],
				terminalStatus: "needs-decision",
				lastStopStatus: "needs-decision",
			}),
		) as Record<string, unknown>;
		expect(v.statusLine).toBe(
			"iteration 1 · proceed · 2/3 required checks passed · needs-decision",
		);
	});

	test("an OPEN loop after a revise shows the round line with no stop clause", () => {
		// A revise that did not exhaust the budget leaves the loop open (terminalStatus unset);
		// the line is the completed round, no terminal word appended.
		const v = loopRunView(
			loopSession({
				iteration: 2,
				lastVerdict: "revise",
				lastVerificationSource: "reviewer",
				lastChecks: [passed("the tests")],
			}),
		) as Record<string, unknown>;
		expect(v.statusLine).toBe("iteration 2 · revise · 1/1 checks passed");
	});

	test("an open loop with NO completed iteration invents no statusLine (field absent)", () => {
		// A freshly opened loop (chit_start, before the first chit_next): iteration 0, no last*
		// mirror -> the field must be absent, never a fabricated line.
		const v = loopRunView(loopSession({ iteration: 0 })) as Record<string, unknown>;
		expect(v.statusLine).toBeUndefined();
	});

	test("a loop cancelled before any iteration completed still has no statusLine", () => {
		// Cancelling the first chit_next writes a cancelled stop with NO iteration record, so the
		// mirror stays empty: terminal, but nothing completed -> no line to show.
		const v = loopRunView(loopSession({ iteration: 0, terminalStatus: "cancelled" })) as Record<
			string,
			unknown
		>;
		expect(v.statusLine).toBeUndefined();
	});

	test("a later cancelled attempt is not attributed to the earlier completed round's line", () => {
		// Reachable mixed state: round 1 completed as a revise (loop stayed open, so no
		// lastStopStatus), then the NEXT chit_next was cancelled mid-flight -- stopTerminal
		// set terminalStatus without advancing the completed-iteration mirror. The line must
		// stay the completed round's own story: no "· cancelled" clause borrowed from round 2
		// (the view's status + stopReason fields carry the cancellation, where it belongs).
		const v = loopRunView(
			loopSession({
				iteration: 1,
				lastVerdict: "revise",
				lastVerificationSource: "reviewer",
				lastChecks: [passed("the tests")],
				terminalStatus: "cancelled",
			}),
		) as Record<string, unknown>;
		expect(v.statusLine).toBe("iteration 1 · revise · 1/1 checks passed");
		expect(v.status).toBe("cancelled"); // the cancellation still shows where it belongs
	});
});

describe("loopRunView activity: the in-flight snapshot for chit_status (is it stuck?)", () => {
	// While an iteration is IN FLIGHT, chit_status -> loopRunView surfaces a compact `activity`
	// object so the calling agent can judge progress WITHOUT the live MCP heartbeats (UI-only,
	// never guaranteed to reach the model). `now` is passed in (the handler's instant) so the
	// derived ages stay deterministic. These pin: activity present + correct while running,
	// absent once settled, and the 0.30.0 terminal/last-completed receipt unchanged.
	const passed = (command: string) => ({ command, status: "passed" as const });

	test("an in-flight iteration adds the activity object WITHOUT clobbering the last-completed statusLine", () => {
		const NOW = 100_000;
		// Reachable mixed state: round 1 completed as a revise (loop stayed open), then chit_next
		// started round 2, now mid-implement. A concurrent chit_status sees BOTH lines.
		const v = loopRunView(
			loopSession({
				iteration: 1,
				lastVerdict: "revise",
				lastVerificationSource: "reviewer",
				lastChecks: [passed("the tests")],
				active: new AbortController(),
				startedAtMs: NOW - 90_000,
				activity: {
					iteration: 2,
					phase: "implementing",
					phaseStartedAtMs: NOW - 30_000,
					lastActivityAtMs: NOW - 5_000,
				},
			}),
			NOW,
		) as Record<string, unknown>;
		// The top-level statusLine is still the LAST COMPLETED round (0.30.0 behavior preserved)...
		expect(v.statusLine).toBe("iteration 1 · revise · 1/1 checks passed");
		// ...and the new activity object narrates the IN-FLIGHT round, exact shape pinned.
		expect(v.activity).toEqual({
			iteration: 2,
			phase: "implementing",
			elapsedMs: 90_000, // now - startedAtMs (whole run, aligned with background JobTiming)
			phaseElapsedMs: 30_000, // now - phaseStartedAtMs
			lastActivityAgeMs: 5_000, // now - lastActivityAtMs
			statusLine: "iteration 2 · implementing · 30s",
		});
		expect(v.status).toBe("running");
		expectNoLeakage(v);
	});

	test("a settled run surfaces no activity (the snapshot was cleared on settle), receipt intact", () => {
		// A converged run: runNextIteration cleared session.activity in its finally, so the view
		// reports only the terminal receipt -- never a stale phase.
		const v = loopRunView(
			loopSession({
				iteration: 1,
				terminalStatus: "converged",
				startedAtMs: 1_000,
				endedAtMs: 5_000,
			}),
			100_000,
		) as Record<string, unknown>;
		expect(v.activity).toBeUndefined();
		expect(v.status).toBe("converged");
		expect(v.elapsedMs).toBe(4_000); // terminal receipt unchanged (endedAtMs - startedAtMs)
	});

	test("the spin-up before the first step shows activity with no phase and a 'starting' line", () => {
		const NOW = 50_000;
		const v = loopRunView(
			loopSession({
				iteration: 0,
				active: new AbortController(),
				startedAtMs: NOW - 2_000,
				activity: { iteration: 1, lastActivityAtMs: NOW - 2_000 }, // no phase recorded yet
			}),
			NOW,
		) as Record<string, unknown>;
		const a = v.activity as Record<string, unknown>;
		expect(a.iteration).toBe(1);
		expect(a.phase).toBeUndefined(); // omitted until the first step starts
		expect(a.phaseElapsedMs).toBeUndefined(); // no phase clock yet
		expect(a.elapsedMs).toBe(2_000);
		expect(a.lastActivityAgeMs).toBe(2_000);
		expect(a.statusLine).toBe("iteration 1 · starting · 2s"); // duration falls back to run elapsed
	});

	test("chit_cancel's flow (cancelConverge then same-now view) surfaces 'cancelling' with non-negative ages", () => {
		// Mirror the chit_cancel handler exactly: mark the in-flight snapshot "cancelling" at
		// `now`, THEN build the returned view against the SAME `now`. The earlier bug stamped
		// the mark at a LATER Date.now() than the view's captured now, so phaseElapsedMs /
		// lastActivityAgeMs went negative; sharing `now` keeps them non-negative (here 0).
		const NOW = 20_000;
		const session = loopSession({
			iteration: 0,
			active: new AbortController(),
			startedAtMs: NOW - 8_000,
			activity: {
				iteration: 1,
				phase: "implementing",
				phaseStartedAtMs: NOW - 3_000,
				lastActivityAtMs: NOW - 2_000,
			},
		});
		expect(cancelConverge(session, NOW).state).toBe("cancelling");
		const v = loopRunView(session, NOW) as Record<string, unknown>;
		const a = v.activity as Record<string, unknown>;
		expect(a.phase).toBe("cancelling");
		expect(a.phaseElapsedMs).toBe(0); // marked at NOW, viewed at NOW -- never negative
		expect(a.lastActivityAgeMs).toBe(0);
		expect(a.elapsedMs).toBe(8_000); // whole-run elapsed unchanged
		expect(a.statusLine).toBe("iteration 1 · cancelling · 0s");
	});
});

describe("backgroundRunView: partial-work visibility on a failed run (partial-work slice)", () => {
	test("a FAILED loop run with a dirty worktree surfaces partialWork (not changedFiles: [])", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-bgpw-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			// the implementer wrote work then the step timed out -> uncommitted in the worktree
			writeFileSync(join(repo, "f.ts"), "WORK IN PROGRESS\n");
			writeFileSync(join(repo, "new.ts"), "x\n");
			const v = backgroundRunView(
				job({
					runId: "bg-fail",
					state: "failed",
					worktreePath: repo,
					failure:
						'manifest run failed at step "implement": claude --print timed out after 900000ms',
					lastHeartbeatAt: undefined,
				}),
			) as Record<string, unknown>;
			const pw = v.partialWork as { files: string[]; diffStat: string; note: string } | undefined;
			expect(pw).toBeDefined();
			expect(pw?.files).toContain("f.ts");
			expect(pw?.files).toContain("new.ts");
			expect(pw?.note).toContain("timed out after 15m");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("a CONVERGED (clean-terminal) run does NOT add partialWork even with a worktree", () => {
		// the happy path is unchanged: changedFiles already covers a converged run's diff.
		const v = backgroundRunView(
			job({
				runId: "bg-ok",
				state: "completed",
				stopStatus: "converged",
				worktreePath: "/wt/does-not-exist",
			}),
		) as Record<string, unknown>;
		expect(v.partialWork).toBeUndefined();
	});

	test("a STALE run (worker died mid-step, state stuck running) surfaces partialWork too", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-stale-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			writeFileSync(join(repo, "f.ts"), "half-written work\n"); // the dead worker's partial edit
			// state "running" but a stale heartbeat (worker dead) -> derived stale, never recorded a stop.
			const v = backgroundRunView(
				job({
					runId: "bg-stale",
					state: "running",
					worktreePath: repo,
					lastHeartbeatAt: "2020-01-01T00:00:00.000Z", // far in the past -> isStale
				}),
			) as Record<string, unknown>;
			const pw = v.partialWork as { files: string[] } | undefined;
			expect(pw?.files).toContain("f.ts");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("a HEALTHY running run does NOT add partialWork (no git I/O on a hot poll)", () => {
		// the default job() is a live-running job (fresh heartbeat) -> not stale -> excluded.
		const v = backgroundRunView(
			job({ runId: "bg-live", state: "running", worktreePath: "/wt/does-not-exist" }),
		) as Record<string, unknown>;
		expect(v.partialWork).toBeUndefined();
	});
});
