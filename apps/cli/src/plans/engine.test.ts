import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	buildLoopReceipt,
	type LoopReceipt,
	type LoopRecord,
	type NormalizedPlan,
	type PlanStep,
} from "@chit-run/core";
import {
	applyRunWorkspace,
	commitWorktree,
	createWorktree,
	type GitRunner,
	realGit,
	removeEmptyDir,
	removeTaskWorktree,
} from "../batches/worktree.ts";
import type { LoopJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import {
	advancePlan,
	applyPlanStep,
	cancelPlan,
	cleanupPlan,
	describePlan,
	type LaunchPlanJobParams,
	listPlans,
	type PlanEngineDeps,
	planWaitState,
	startPlan,
} from "./engine.ts";
import { PlanStore } from "./store.ts";
import type { Plan, PlanStepRecord } from "./types.ts";

// A fake job world: launchJob registers a queued job (mirroring the real launchConvergeJob,
// which the worker later flips to running); tests then settle a job to simulate the worker
// finishing. The worktree metadata is spread onto the record so a launched step is applyable
// like a real background run.
class FakeJobs {
	jobs = new Map<string, LoopJobRecord>();
	launched: Array<{
		jobId: string;
		cwd: string;
		scope: string;
		manifestPath?: string;
		requiredChecks?: LaunchPlanJobParams["requiredChecks"];
		callTimeoutMs?: number;
		maxIterations: number;
		worktree: LaunchPlanJobParams["worktree"];
	}> = [];
	cancelled: string[] = [];
	private seq = 0;

	launch = (p: LaunchPlanJobParams): { jobId: string; loopId: string } => {
		const jobId = `job-${++this.seq}`;
		this.jobs.set(jobId, {
			runId: jobId,
			policy: "loop",
			loopId: p.loopId,
			repoKey: "k",
			cwd: p.cwd,
			...p.worktree,
			scope: p.scope,
			task: p.task,
			maxIterations: p.maxIterations,
			allowUnenforced: false,
			state: "queued",
			createdAt: "t",
			iterationsCompleted: 0,
			auditRefs: [],
		});
		this.launched.push({
			jobId,
			cwd: p.cwd,
			scope: p.scope,
			manifestPath: p.manifestPath,
			requiredChecks: p.requiredChecks,
			callTimeoutMs: p.callTimeoutMs,
			maxIterations: p.maxIterations,
			worktree: p.worktree,
		});
		return { jobId, loopId: p.loopId };
	};
	get = (jobId: string): LoopJobRecord | undefined => this.jobs.get(jobId);
	cancel = (jobId: string): void => {
		this.cancelled.push(jobId);
	};
	// Test helper: settle a job to a terminal state (completed by default).
	finish(jobId: string, over: Partial<LoopJobRecord>): void {
		const j = this.jobs.get(jobId);
		if (j) this.jobs.set(jobId, { ...j, state: "completed", iterationsCompleted: 1, ...over });
	}
	// Test helper: mutate a job in place (e.g. flip it to running with a phase).
	patch(jobId: string, over: Partial<LoopJobRecord>): void {
		const j = this.jobs.get(jobId);
		if (j) this.jobs.set(jobId, { ...j, ...over });
	}
}

// A minimal but realistic loop log -- one converged iteration plus its stop record -- fed
// through the REAL buildLoopReceipt, so the receipt the fake loopDetail hands back is the same
// safe v0.38 shape the MCP wiring produces (no participants, env values, prompts, or blob
// bodies live in it). settleStep snapshots this onto the durable step.
const SAMPLE_RECORDS: LoopRecord[] = [
	{
		type: "iteration",
		n: 1,
		implementSummary: "did the work",
		changedFiles: ["f.ts"],
		workspaceWarnings: [],
		checksRun: "1/1 required checks passed",
		verdict: "proceed",
		findingCount: 0,
		decision: "proceed",
		checkDurationMs: 10,
		at: "2026-01-01T00:00:00.000Z",
		auditRef: "audit-1",
	},
	{
		type: "stop",
		status: "converged",
		reason: "reviewer approved",
		iterations: 1,
		totalElapsedMs: 100,
		endedAt: "2026-01-01T00:00:05.000Z",
	},
];
const SAMPLE_RECEIPT: LoopReceipt = buildLoopReceipt(SAMPLE_RECORDS);

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: PlanStore;
let jobs: FakeJobs;
let deps: PlanEngineDeps;
let intSeq = 0;
let stepSeq = 0;

// A plain main-repo checkout: the shared git common dir is <toplevel>/.git, so
// mainRepoOfWorktree resolves back to cwd -- repo === callerCheckout for a non-linked launch.
const fakeGit: GitRunner = (args) => {
	if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
		return { code: 0, stdout: `${cwd}\n`, stderr: "" };
	}
	if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
		return { code: 0, stdout: `${cwd}/.git\n`, stderr: "" };
	}
	if (args[0] === "rev-parse") return { code: 0, stdout: "basesha\n", stderr: "" };
	return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
	// realpath so the fake's --git-common-dir derivation (which runs realpathSync) matches
	// repoToplevel's raw cwd exactly -- otherwise macOS's /var -> /private/var symlink makes
	// repo and callerCheckout differ for a plain main-repo launch.
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-plan-cwd-")));
	stateDir = mkdtempSync(join(tmpdir(), "chit-plan-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new PlanStore(cwd);
	jobs = new FakeJobs();
	intSeq = 0;
	stepSeq = 0;
	deps = {
		git: fakeGit,
		createIntegrationWorktree: (_repo, planId) => ({
			worktreePath: `/wt/${planId}/integration-${++intSeq}`,
			branch: `chit-plan/${planId}/integration`,
		}),
		createStepWorktree: (_repo, planId, stepId) => ({
			worktreePath: `/wt/${planId}/${stepId}-${++stepSeq}`,
			branch: `chit-plan/${planId}/${stepId}`,
		}),
		launchJob: jobs.launch,
		getJob: jobs.get,
		cancelJob: jobs.cancel,
		isStale: () => false,
		loopDetail: () => ({
			changedFiles: ["f.ts"],
			workspaceWarnings: [],
			receipt: SAMPLE_RECEIPT,
		}),
		// The fake-git scheduling tests never apply/commit/remove; the real-git apply + cleanup tests
		// below build their own deps. Throw loudly if a scheduling test reaches these by accident.
		applyWorkspace: () => {
			throw new Error("applyWorkspace is not wired in the fake-git scheduling harness");
		},
		commit: () => {
			throw new Error("commit is not wired in the fake-git scheduling harness");
		},
		removeWorktree: () => {
			throw new Error("removeWorktree is not wired in the fake-git scheduling harness");
		},
		removeEmptyDir: () => {
			throw new Error("removeEmptyDir is not wired in the fake-git scheduling harness");
		},
		now: () => 1000,
	};
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
	return { id, title: id, body: `do ${id}`, dependsOn: [], ...over };
}

// A strict chain: b depends on a (a's diff must be APPLIED before b launches).
function chainPlan(over: Partial<NormalizedPlan> = {}): NormalizedPlan {
	return {
		schema: 1,
		title: "test plan",
		cleanup: "after_apply",
		steps: [step("a"), step("b", { dependsOn: ["a"] })],
		...over,
	};
}

// Guard helper: assert-present without a non-null assertion (keeps the lint clean).
function present<T>(v: T | undefined, what: string): T {
	if (v === undefined) throw new Error(`expected ${what} to be present`);
	return v;
}
const stepOf = (c: Plan, id: string): PlanStepRecord =>
	present(
		c.steps.find((s) => s.id === id),
		`step ${id}`,
	);

// Simulate the (future) gated apply-then-commit slice: mark a step applied and advance the
// integration tip to the commit the apply produced, so a dependent is cut from it.
function applyStep(planId: string, stepId: string, commitSha: string): void {
	store.update(planId, (c) => {
		const s = present(
			c.steps.find((x) => x.id === stepId),
			`step ${stepId}`,
		);
		s.status = "applied";
		s.appliedCommitSha = commitSha;
		c.integrationTipSha = commitSha;
		return c;
	});
}

describe("startPlan", () => {
	test("creates the integration worktree and launches exactly the first strict-chain step", () => {
		const c = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// The integration branch was cut at start and recorded, tip at the base.
		expect(c.integrationBranch).toBe("chit-plan/p1/integration");
		expect(c.integrationWorktree).toBe("/wt/p1/integration-1");
		expect(c.integrationTipSha).toBe("basesha");
		// Only the first step launched; the dependent stays pending.
		expect(stepOf(c, "a").status).toBe("running");
		expect(stepOf(c, "b").status).toBe("pending");
		expect(jobs.launched).toHaveLength(1);
		expect(c.status).toBe("running");
		const a = stepOf(c, "a");
		expect(a.worktreePath && a.branch && a.runId).toBeTruthy();
	});

	test("splits repo (main) and callerCheckout (launcher), resolving baseSha from the launcher", () => {
		// Launch from /wt/feature (a linked worktree) whose shared .git lives at /main/.git. repo must
		// resolve to the durable main repo (/main), callerCheckout to the launching checkout, and the
		// base ref must resolve against the launcher, never the main repo.
		const revParseCwds: string[] = [];
		const git: GitRunner = (args, gitCwd) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				return { code: 0, stdout: "/wt/feature\n", stderr: "" };
			}
			if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
				return { code: 0, stdout: "/main/.git\n", stderr: "" };
			}
			if (args[0] === "rev-parse") {
				revParseCwds.push(gitCwd);
				return { code: 0, stdout: "basesha\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const c = startPlan(store, { ...deps, git }, { id: "p1", cwd, normalizedPlan: chainPlan() });
		expect(c.repo).toBe("/main");
		expect(c.callerCheckout).toBe("/wt/feature");
		// repoKey is keyed off the DURABLE main repo, not the launching checkout, so it matches the
		// PlanStore namespace and survives the linked launching worktree being removed before recovery.
		expect(c.repoKey).toBe(repoKey("/main"));
		expect(c.repoKey).not.toBe(repoKey("/wt/feature"));
		// The base ref was resolved from the launching checkout, not the main repo.
		expect(revParseCwds).toContain("/wt/feature");
		expect(revParseCwds).not.toContain("/main");
		// And both reach launchJob distinctly: cleanup will anchor on /main, apply targets /wt/feature.
		const launched = present(jobs.launched.at(-1), "launched a");
		expect(launched.worktree.repo).toBe("/main");
		expect(launched.worktree.callerCheckout).toBe("/wt/feature");
	});

	test("records the step's managed worktree on the launched job (so chit_apply can resolve it)", () => {
		const c = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const a = stepOf(c, "a");
		const aWorktree = present(a.worktreePath, "step a worktreePath");
		const aBranch = present(a.branch, "step a branch");
		const launched = present(jobs.launched.at(-1), "launched a");
		// The step is cut from the integration tip (the base at start), at the durable main repo.
		expect(launched.worktree).toEqual({
			worktreePath: aWorktree,
			branch: aBranch,
			baseSha: "basesha",
			repo: c.repo,
			callerCheckout: c.callerCheckout,
		});
		// And it landed on the JOB RECORD -- the exact fields resolveRunWorkspace reads.
		const job = present(jobs.get(launched.jobId), "job record");
		expect(job.worktreePath).toBe(aWorktree);
		expect(job.baseSha).toBe("basesha");
		expect(job.callerCheckout).toBe(c.callerCheckout);
	});

	test("links tooling from the launching checkout into the STEP worktree (not integration)", () => {
		// The fix for the 0.39 dogfood: a step worktree is a fresh git worktree with no node_modules,
		// so its checks fail with a missing binary. The step worktree must receive the launching
		// checkout (callerCheckout) as the tooling source. The integration worktree must NOT -- a
		// node_modules symlink there would be committed by the step commit's `git add -A`.
		const stepToolingSources: string[] = [];
		const capturing: PlanEngineDeps = {
			...deps,
			createStepWorktree: (repo, planId, stepId, sha, toolingSource) => {
				stepToolingSources.push(toolingSource);
				return deps.createStepWorktree(repo, planId, stepId, sha, toolingSource);
			},
		};
		const c = startPlan(store, capturing, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// For a plain main-repo launch callerCheckout === cwd; the point is it is threaded, not invented.
		expect(stepToolingSources).toEqual([c.callerCheckout]); // the first launched step
		expect(c.callerCheckout).toBe(cwd);
	});

	test("copies step overrides onto the launched job (maxIterations, checks, manifest, timeout)", () => {
		const plan = chainPlan({
			steps: [
				step("a", {
					maxIterations: 5,
					manifestPath: "/m.json",
					callTimeoutMs: 900000,
					requiredChecks: [{ command: "bun", args: ["run", "check"] }],
				}),
			],
		});
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: plan, maxIterations: 3 });
		const launched = present(jobs.launched.at(-1), "launched a");
		expect(launched.maxIterations).toBe(5); // step override beats the plan default
		expect(launched.manifestPath).toBe("/m.json");
		expect(launched.callTimeoutMs).toBe(900000);
		expect(launched.requiredChecks).toEqual([{ command: "bun", args: ["run", "check"] }]);
	});

	test("a worktree/job launch failure fails only that step and keeps the plan record", () => {
		const failingDeps: PlanEngineDeps = {
			...deps,
			launchJob: () => {
				throw new Error("spawn failed");
			},
		};
		const c = startPlan(store, failingDeps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// The step failed, but the plan record exists and start did not throw.
		expect(stepOf(c, "a").status).toBe("failed");
		expect(stepOf(c, "a").error).toContain("spawn failed");
		// The worktree fields are still recorded for future cleanup.
		expect(stepOf(c, "a").worktreePath).toBeDefined();
		expect(present(store.get("p1"), "plan p1").status).toBe("failed");
	});
});

describe("advancePlan: dependency gating", () => {
	test("a review_ready first step blocks launching the dependent until it is applied", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		const c1 = advancePlan(store, deps, "p1");
		// a settled review_ready; b must NOT launch (review_ready does not satisfy a code dependency).
		expect(stepOf(c1, "a").status).toBe("review_ready");
		expect(stepOf(c1, "b").status).toBe("pending");
		expect(jobs.launched).toHaveLength(1);
		expect(c1.status).toBe("ready_for_apply");
	});

	test("after step A is applied, advancePlan launches step B cut from the advanced tip", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		advancePlan(store, deps, "p1"); // a -> review_ready
		// Simulate the gated apply-then-commit: a is applied and the tip advances to its commit.
		applyStep("p1", "a", "appliedsha");
		const c2 = advancePlan(store, deps, "p1");
		// b launches now, cut from the advanced integration tip (so it sees a's applied code).
		expect(stepOf(c2, "b").status).toBe("running");
		expect(stepOf(c2, "b").baseSha).toBe("appliedsha");
		const launchedB = present(jobs.launched.at(-1), "launched b");
		expect(launchedB.worktree.baseSha).toBe("appliedsha");
		expect(c2.status).toBe("running");
	});
});

describe("advancePlan: reconciliation", () => {
	test("a completed converged job reconciles to review_ready with audit refs and changedFiles", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", {
			stopStatus: "converged",
			auditRefs: ["audit-1"],
			lastVerdict: "proceed",
		});
		const c1 = advancePlan(store, deps, "p1");
		const a = stepOf(c1, "a");
		expect(a.status).toBe("review_ready");
		expect(a.auditRefs).toEqual(["audit-1"]);
		expect(a.changedFiles).toEqual(["f.ts"]);
		expect(a.stopStatus).toBe("converged");
		expect(a.lastVerdict).toBe("proceed");
		// The compact loop receipt is snapshotted from the same settle-time loop read, so a terminal
		// step carries the v0.38 receipt shape on its durable record.
		expect(a.receipt).toEqual(SAMPLE_RECEIPT);
	});

	test("a still-running step has not invented a receipt before it settles", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// The worker is mid-run (running, not terminal); reconcile leaves the step running.
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		const c1 = advancePlan(store, deps, "p1");
		const a = stepOf(c1, "a");
		expect(a.status).toBe("running");
		// No settle happened, so no receipt is recorded (loopDetail is only read at settle).
		expect(a.receipt).toBeUndefined();
	});

	test("a completed but not-converged job reconciles to needs_human", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "max-iterations" });
		const c1 = advancePlan(store, deps, "p1");
		expect(stepOf(c1, "a").status).toBe("needs_human");
		expect(c1.status).toBe("needs_human");
		// The dependent stays pending and never launches past a paused step.
		expect(stepOf(c1, "b").status).toBe("pending");
	});

	test("a stale running job reconciles to failed", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// The job is still running (not terminal), but the worker is gone/silent.
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		const c1 = advancePlan(store, { ...deps, isStale: () => true }, "p1");
		expect(stepOf(c1, "a").status).toBe("failed");
		expect(stepOf(c1, "a").error).toContain("stale");
		expect(c1.status).toBe("failed");
	});

	test("a vanished job record reconciles to failed", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.jobs.delete(stepOf(c0, "a").runId ?? "");
		const c1 = advancePlan(store, deps, "p1");
		expect(stepOf(c1, "a").status).toBe("failed");
		expect(stepOf(c1, "a").error).toContain("job record not found");
	});

	test("a just-launched queued job is not settled by an immediate advance", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const c1 = advancePlan(store, deps, "p1"); // job is still queued
		expect(stepOf(c1, "a").status).toBe("running");
		expect(c1.status).toBe("running");
	});
});

describe("planWaitState (what chit_wait blocks on for a plan)", () => {
	test("a live running step, nothing reconcilable -> working (keep waiting)", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// Step a's job is queued and not stale: the next advance would do nothing yet.
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("working");
	});

	test("a finished active job -> needs_advance (advance would reconcile it)", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged", lastVerdict: "proceed" });
		// A completed job is settleable, so the next advance would reconcile it. The wait must NOT
		// advance: the plan stays untouched (step a is still recorded "running").
		const before = present(store.get("p1"), "p1");
		expect(planWaitState(before, deps)).toBe("needs_advance");
		expect(stepOf(present(store.get("p1"), "p1"), "a").status).toBe("running");
	});

	test("a stale worker -> needs_advance (so a wait never hangs on a dead worker)", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		const staleDeps: PlanEngineDeps = { ...deps, isStale: () => true };
		expect(planWaitState(present(store.get("p1"), "p1"), staleDeps)).toBe("needs_advance");
	});

	test("a vanished job record -> needs_advance (advance would fail it, not hang)", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.jobs.delete(stepOf(c0, "a").runId ?? "");
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("needs_advance");
	});

	test("a review_ready step -> ready_for_apply (return at once, do not block)", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		advancePlan(store, deps, "p1"); // a -> review_ready, plan -> ready_for_apply
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("ready_for_apply");
	});

	test("a completed plan -> terminal", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan({ steps: [step("a")] }) });
		jobs.finish(stepOf(present(store.get("p1"), "p1"), "a").runId ?? "", {
			stopStatus: "converged",
		});
		advancePlan(store, deps, "p1"); // a -> review_ready
		applyStep("p1", "a", "appliedsha"); // a -> applied, plan -> completed
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("terminal");
	});

	test("a cancelled plan -> terminal", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		cancelPlan(store, deps, "p1");
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("terminal");
	});

	test("a failed plan -> terminal", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		advancePlan(store, { ...deps, isStale: () => true }, "p1"); // a -> failed, plan -> failed
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("terminal");
	});

	test("a needs_human plan -> terminal (paused for a decision, nothing to wait on)", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "max-iterations" });
		advancePlan(store, deps, "p1"); // a -> needs_human, plan -> needs_human
		expect(planWaitState(present(store.get("p1"), "p1"), deps)).toBe("terminal");
	});
});

describe("cancelPlan", () => {
	test("cancels running jobs, marks pending/running cancelled, and keeps worktrees", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const aRun = stepOf(c0, "a").runId ?? "";
		const c1 = cancelPlan(store, deps, "p1");
		expect(jobs.cancelled).toEqual([aRun]); // the running step's job was cancelled
		expect(stepOf(c1, "a").status).toBe("cancelled");
		expect(stepOf(c1, "b").status).toBe("cancelled"); // the pending dependent too
		expect(c1.status).toBe("cancelled");
		// Worktrees are kept (no remover dep exists; cleanup is a separate slice). The step's
		// worktree path is still recorded.
		expect(stepOf(c1, "a").worktreePath).toBeDefined();
	});
});

describe("describePlan (read-only join)", () => {
	test("surfaces live job state and phase for a running step without mutating", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.patch(stepOf(c0, "a").runId ?? "", {
			state: "running",
			phase: "implementing",
			lastVerdict: "revise",
		});
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.runState).toBe("running");
		expect(aView.phase).toBe("implementing");
		expect(aView.lastVerdict).toBe("revise");
		// The view is read-only: the stored step is untouched (still no recorded verdict).
		expect(stepOf(present(store.get("p1"), "plan p1"), "a").lastVerdict).toBeUndefined();
		// Plan-level fields surface for the receipt.
		expect(view.plan_id).toBe("p1");
		expect(view.integrationBranch).toBe("chit-plan/p1/integration");
		expect(view.nextAction).toContain("in flight");
	});

	test("surfaces the joined loop job's participant provenance for a running step", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
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
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running", participants });
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.participants).toEqual(participants);
		// Only env key names surface; no env values.
		expect(JSON.stringify(aView.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});

	test("a terminal (reconciled) step row keeps the provenance after the live job join is gone", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
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
		// The job converged carrying its provenance; reconcile snapshots it into the durable step.
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged", participants });
		const c1 = advancePlan(store, deps, "p1");
		expect(stepOf(c1, "a").status).toBe("review_ready");
		// Re-describe AFTER reconcile: the step is no longer running, so provenance must come from
		// the snapshotted step record, not the live job join.
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.status).toBe("review_ready");
		expect(aView.participants).toEqual(participants);
		expect(JSON.stringify(aView.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});

	test("surfaces the receipt on a reconciled review_ready step and keeps it after the live job join is gone", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		const c1 = advancePlan(store, deps, "p1"); // a -> review_ready (snapshots the receipt)
		expect(stepOf(c1, "a").status).toBe("review_ready");
		// Re-describe AFTER reconcile: the step is no longer running, so the receipt must come from
		// the snapshotted step record, not a live job join.
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.status).toBe("review_ready");
		expect(aView.receipt).toEqual(SAMPLE_RECEIPT);
	});

	test("a running step has no receipt until reconcile settles it", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// A live, mid-run loop job: describe joins live verdict/phase but invents no receipt.
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running", phase: "implementing" });
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.runState).toBe("running");
		expect(aView.receipt).toBeUndefined();
	});

	test("the receipt is separate from participants and leaks no env keys or prompts", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
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
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged", participants });
		advancePlan(store, deps, "p1");
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		// The receipt is its own field; participant provenance is NOT folded into it.
		expect(aView.receipt).toEqual(SAMPLE_RECEIPT);
		expect(aView.participants).toEqual(participants);
		expect(aView.receipt).not.toHaveProperty("participants");
		// The safe v0.38 shape carries no env values, prompts, outputs, or blob bodies.
		const receiptJson = JSON.stringify(aView.receipt);
		expect(receiptJson).not.toContain("ANTHROPIC_API_KEY");
		expect(receiptJson).not.toContain("do a"); // the step body / prompt never leaks in
	});

	test("surfaces the effective per-call timeout for a step that carries one", () => {
		const plan = chainPlan({
			steps: [step("a", { callTimeoutMs: 900_000 }), step("b", { dependsOn: ["a"] })],
		});
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: plan, maxIterations: 3 });
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		const bView = present(
			view.steps.find((s) => s.id === "b"),
			"step b view",
		);
		expect(aView.callTimeoutMs).toBe(900_000); // the override shows in the step view
		expect(bView.callTimeoutMs).toBeUndefined(); // absent when the step set none
	});

	test("marks a running step stale in the view when the worker is gone", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		const view = describePlan(present(store.get("p1"), "plan p1"), {
			...deps,
			isStale: () => true,
		});
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.runState).toBe("stale");
	});

	test("marks a still-queued step stale in the view when the worker never started", () => {
		// A just-launched job stays queued until the worker boots. If that worker never appears,
		// reconcile settles the step failed (a stale queued job is reconcilable), so describe must
		// agree and surface "stale", not a bare "queued" that contradicts nextAction.
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() }); // job stays queued
		const view = describePlan(present(store.get("p1"), "plan p1"), {
			...deps,
			isStale: () => true,
		});
		const aView = present(
			view.steps.find((s) => s.id === "a"),
			"step a view",
		);
		expect(aView.runState).toBe("stale");
		// And it reports as reconcilable work, so advancing would settle it.
		expect(view.nextAction).toContain("chit_plan_advance");
	});

	// nextAction is surfaced publicly through describePlan. A review_ready step's guidance must use
	// the REAL apply tool shape (chit_plan_advance with an apply payload), and must NOT suggest
	// cleanup -- cleanup is refused while a step is review_ready.
	test("a review_ready (ready_for_apply) plan instructs the gated apply via chit_plan_advance, not cleanup", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		const c1 = advancePlan(store, deps, "p1"); // a -> review_ready
		const view = describePlan(c1, deps);
		expect(view.status).toBe("ready_for_apply");
		// The forward move is the gated apply, named with its real shape.
		expect(view.nextAction).toContain("chit_plan_advance");
		expect(view.nextAction).toContain("apply");
		expect(view.nextAction).toContain("step a");
		// Cleanup is refused at ready_for_apply (unapplied reviewable work), so it must NOT be suggested.
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
	});

	test("a just-cancelled plan whose worker is still live does NOT suggest chit_plan_cleanup", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		// cancelPlan best-effort cancels the job but the worker settles in the background; the job is
		// still queued/running here (not stale), so its worktree must not be offered for cleanup yet.
		jobs.patch(stepOf(c0, "a").runId ?? "", { state: "running" });
		const view = describePlan(cancelPlan(store, deps, "p1"), deps);
		expect(view.status).toBe("cancelled");
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
	});

	test("a cancelled plan suggests chit_plan_cleanup once its worker has settled", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const aRun = stepOf(c0, "a").runId ?? "";
		cancelPlan(store, deps, "p1");
		// The background worker actually exits and the job reaches a terminal state -- now no live
		// worker holds the worktree, so cleanup is available and the guidance points at it.
		jobs.patch(aRun, { state: "cancelled" });
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		expect(view.status).toBe("cancelled");
		expect(view.nextAction).toContain("chit_plan_cleanup");
	});

	// Drive a single-step plan to completed (applied), so cleanup is available and the guidance
	// reflects whether the plan was already cleaned.
	function completedSinglePlan(): Plan {
		const c0 = startPlan(store, deps, {
			id: "p1",
			cwd,
			normalizedPlan: chainPlan({ steps: [step("a")] }),
		});
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		advancePlan(store, deps, "p1"); // a -> review_ready
		applyStep("p1", "a", "appliedsha"); // simulate the gated apply marking a applied
		return advancePlan(store, deps, "p1"); // re-derives status -> completed
	}

	test("a completed plan without cleanedAt still suggests chit_plan_cleanup", () => {
		const view = describePlan(completedSinglePlan(), deps);
		expect(view.status).toBe("completed");
		expect(view.cleanedAt).toBeUndefined();
		expect(view.nextAction).toContain("chit_plan_cleanup");
	});

	test("a completed plan with cleanedAt does NOT suggest chit_plan_cleanup and reports the retired state", () => {
		completedSinglePlan();
		store.update("p1", (c) => {
			c.cleanedAt = "2026-06-06T00:00:00.000Z";
			return c;
		});
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		expect(view.status).toBe("completed");
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
		// It still mentions the useful terminal state: worktrees already retired, receipts kept.
		expect(view.nextAction).toContain("already retired");
		expect(view.nextAction).toContain("2026-06-06T00:00:00.000Z");
		expect(view.nextAction).toContain("receipts remain available");
		// Cleanup already removed the integration branch, so do not point the operator at it.
		expect(view.nextAction).not.toContain("integration branch");
		expect(view.nextAction).not.toContain("merge/apply");
	});

	test("a cancelled plan with cleanedAt does NOT suggest chit_plan_cleanup and reports the retired state", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const aRun = stepOf(c0, "a").runId ?? "";
		cancelPlan(store, deps, "p1");
		jobs.patch(aRun, { state: "cancelled" }); // worker settled
		store.update("p1", (c) => {
			c.cleanedAt = "2026-06-06T00:00:00.000Z";
			return c;
		});
		const view = describePlan(present(store.get("p1"), "plan p1"), deps);
		expect(view.status).toBe("cancelled");
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
		expect(view.nextAction).toContain("already retired");
		expect(view.nextAction).toContain("receipts remain available");
	});
});

describe("listPlans", () => {
	test("returns compact, newest-first summaries", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const summaries = listPlans(store);
		expect(summaries).toHaveLength(1);
		const s = present(summaries[0], "summary");
		expect(s.plan_id).toBe("p1");
		expect(s.title).toBe("test plan");
		expect(s.status).toBe("running");
		expect(s.stepCount).toBe(2);
		expect(s.applied).toBe(0);
		expect(s.reviewReady).toBe(0);
	});

	test("caps the summaries at the given limit", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		startPlan(store, deps, { id: "p2", cwd, normalizedPlan: chainPlan() });
		expect(listPlans(store, 1)).toHaveLength(1);
	});
});

// --- gated apply + cleanup, verified against REAL git ----------------------
//
// These exercise the apply-then-commit gate and cleanup end to end on a real repository: a real
// integration worktree, real step worktrees, the real applyRunWorkspace/commitWorktree/
// removeTaskWorktree primitives. The fake launchJob plays the converge implementer by writing a
// tracked diff into the step worktree, so a settled step has a genuine diff to apply. realRoots
// (created per test) are cleaned in the shared afterEach.
const realRoots: string[] = [];
afterEach(() => {
	for (const r of realRoots) rmSync(r, { recursive: true, force: true });
	realRoots.length = 0;
});

function run(repo: string, args: string[]): string {
	const r = realGit(args, repo);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout;
}

interface RealHarness {
	repo: string;
	baseSha: string;
	store: PlanStore;
	deps: PlanEngineDeps;
	jobs: Map<string, LoopJobRecord>;
	finish: (jobId: string, over: Partial<LoopJobRecord>) => void;
}

// A real git repo with one committed file (base.txt = "hello\n"), and engine deps wired to real
// worktree creation + the real apply/commit/cleanup primitives. launchJob simulates the implementer
// by appending a line to base.txt in the step worktree (a tracked diff vs the step's base).
function realHarness(): RealHarness {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "chit-plan-real-")));
	realRoots.push(root);
	const repo = join(root, "repo");
	const wtRoot = join(root, "wt");
	run(root, ["init", "-q", repo]);
	run(repo, ["config", "user.email", "test@example.com"]);
	run(repo, ["config", "user.name", "Test"]);
	writeFileSync(join(repo, "base.txt"), "hello\n");
	run(repo, ["add", "-A"]);
	run(repo, ["commit", "-q", "-m", "base"]);
	const baseSha = run(repo, ["rev-parse", "HEAD"]).trim();

	const jobs = new Map<string, LoopJobRecord>();
	let seq = 0;
	const deps: PlanEngineDeps = {
		git: realGit,
		createIntegrationWorktree: (r, planId, sha) =>
			createWorktree(
				realGit,
				r,
				join(wtRoot, planId, "integration"),
				`chit-plan/${planId}/integration`,
				sha,
			),
		createStepWorktree: (r, planId, stepId, sha, toolingSource) =>
			createWorktree(
				realGit,
				r,
				join(wtRoot, planId, "steps", stepId),
				`chit-plan/${planId}/steps/${stepId}`,
				sha,
				toolingSource,
			),
		launchJob: (p) => {
			// The implementer's tracked diff: append a step-identifying line to base.txt. The leaf of
			// the worktree path is the step id (see createStepWorktree above).
			appendFileSync(join(p.cwd, "base.txt"), `from-${basename(p.cwd)}\n`);
			const jobId = `job-${++seq}`;
			jobs.set(jobId, {
				runId: jobId,
				policy: "loop",
				loopId: p.loopId,
				repoKey: "k",
				cwd: p.cwd,
				...p.worktree,
				scope: p.scope,
				task: p.task,
				maxIterations: p.maxIterations,
				allowUnenforced: false,
				state: "queued",
				createdAt: "t",
				iterationsCompleted: 0,
				auditRefs: [],
			});
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => jobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({
			changedFiles: ["base.txt"],
			workspaceWarnings: [],
			receipt: SAMPLE_RECEIPT,
		}),
		applyWorkspace: (p) => applyRunWorkspace(realGit, p),
		commit: (w, m) => commitWorktree(realGit, w, m),
		removeWorktree: (r, w, b) => removeTaskWorktree(realGit, r, w, b),
		removeEmptyDir: (dir) => removeEmptyDir(dir),
		now: () => 1000,
	};
	return {
		repo,
		baseSha,
		store: new PlanStore(repo),
		deps,
		jobs,
		finish: (jobId, over) => {
			const j = jobs.get(jobId);
			if (j) jobs.set(jobId, { ...j, state: "completed", iterationsCompleted: 1, ...over });
		},
	};
}

describe("plan worktree tooling link (real git)", () => {
	test("the STEP worktree links node_modules from the launching checkout; integration does not", () => {
		const h = realHarness();
		// A project that ignores node_modules with the conventional directory-only pattern (which does
		// NOT match a symlink): the symlink would dirty/commit into the integration worktree if linked.
		writeFileSync(join(h.repo, ".gitignore"), "node_modules/\n");
		run(h.repo, ["add", ".gitignore"]);
		run(h.repo, ["commit", "-q", "-m", "ignore node_modules"]);
		// The launching checkout (h.repo) has installed tooling; a fresh managed worktree does not.
		mkdirSync(join(h.repo, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(h.repo, "node_modules", "marker.txt"), "tool");

		const c = startPlan(h.store, h.deps, {
			id: "p",
			cwd: h.repo,
			normalizedPlan: chainPlan({ steps: [step("a")] }),
		});

		// The launched step's worktree carries a node_modules symlink resolving to the repo's tooling,
		// so its checks can find installed binaries.
		const aWt = present(stepOf(c, "a").worktreePath, "step a worktree");
		expect(lstatSync(join(aWt, "node_modules")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(aWt, "node_modules", "marker.txt"), "utf-8")).toBe("tool");

		// The integration worktree is NOT linked: it never runs checks and a node_modules symlink would
		// be staged by the step commit's `git add -A`. So it has no node_modules and stays clean for the
		// apply gate (which a directory-only ignore would NOT keep clean for a symlink).
		const integration = present(c.integrationWorktree, "integration worktree");
		expect(existsSync(join(integration, "node_modules"))).toBe(false);
		expect(run(integration, ["status", "--porcelain"]).trim()).toBe("");
	});
});

// Start a single-step plan and settle that step to review_ready (converged), returning the harness
// and the post-settle plan. The integration worktree exists and the step's diff is uncommitted in
// its own worktree, ready for the gated apply.
function reviewReadySingle(h: RealHarness, stepId = "a"): { plan: Plan } {
	const started = startPlan(h.store, h.deps, {
		id: "p",
		cwd: h.repo,
		normalizedPlan: chainPlan({ steps: [step(stepId)] }),
	});
	h.finish(stepOf(started, stepId).runId ?? "", { stopStatus: "converged" });
	return { plan: advancePlan(h.store, h.deps, "p") };
}

describe("applyPlanStep (real git)", () => {
	test("dry run reports what would apply and mutates neither the integration worktree nor plan state", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		expect(stepOf(plan, "a").status).toBe("review_ready");
		const integration = present(plan.integrationWorktree, "integration worktree");
		const headBefore = run(integration, ["rev-parse", "HEAD"]).trim();
		const contentBefore = readFileSync(join(integration, "base.txt"), "utf-8");

		const outcome = applyPlanStep(h.store, h.deps, {
			planId: "p",
			stepId: "a",
			confirm: false,
		});
		expect(outcome.confirmed).toBe(false);
		expect(outcome.apply.trackedFiles).toContain("base.txt");
		expect(outcome.apply.appliesClean).toBe(true);
		expect(outcome.stepApplied).toBe(false);
		expect(outcome.appliedCommitSha).toBeUndefined();

		// Nothing mutated: the integration HEAD/content is unchanged and the step is still review_ready.
		expect(run(integration, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
		expect(readFileSync(join(integration, "base.txt"), "utf-8")).toBe(contentBefore);
		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("review_ready");
		expect(stepOf(stored, "a").appliedCommitSha).toBeUndefined();
		expect(stored.integrationTipSha).toBe(h.baseSha);
	});

	test("confirm commits the step diff, records appliedCommitSha, advances the tip, marks applied", () => {
		const h = realHarness();
		reviewReadySingle(h);
		const outcome = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		expect(outcome.stepApplied).toBe(true);
		expect(outcome.apply.applied).toBe(true);
		const sha = present(outcome.appliedCommitSha, "applied commit sha");

		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("applied");
		expect(stepOf(stored, "a").appliedCommitSha).toBe(sha);
		expect(stored.integrationTipSha).toBe(sha);
		expect(stored.status).toBe("completed"); // the only step is applied
		// The apply only changes status/commit; the receipt snapshotted at review_ready survives onto
		// the applied row, and describePlan still surfaces it.
		expect(stepOf(stored, "a").receipt).toEqual(SAMPLE_RECEIPT);
		const appliedView = present(
			describePlan(stored, h.deps).steps.find((s) => s.id === "a"),
			"applied step a view",
		);
		expect(appliedView.receipt).toEqual(SAMPLE_RECEIPT);

		// The integration branch advanced by exactly one commit, with the deterministic message and the
		// step's change committed.
		const integration = present(stored.integrationWorktree, "integration worktree");
		expect(run(integration, ["rev-parse", "HEAD"]).trim()).toBe(sha);
		expect(run(integration, ["log", "-1", "--pretty=%s"]).trim()).toBe("plan step a: a");
		expect(run(integration, ["rev-list", "--count", `${h.baseSha}..HEAD`]).trim()).toBe("1");
		expect(readFileSync(join(integration, "base.txt"), "utf-8")).toContain("from-a");
		// A clean tree: the apply landed as a commit, nothing left staged/unstaged.
		expect(run(integration, ["status", "--porcelain"]).trim()).toBe("");
	});

	test("a dependent launches only after the prior step is applied, cut from the commit that includes it", () => {
		const h = realHarness();
		// a -> b (b depends on a). Start launches a; settle + apply a, then advance launches b.
		const started = startPlan(h.store, h.deps, {
			id: "p",
			cwd: h.repo,
			normalizedPlan: chainPlan(),
		});
		expect(stepOf(started, "b").status).toBe("pending");
		h.finish(stepOf(started, "a").runId ?? "", { stopStatus: "converged" });
		advancePlan(h.store, h.deps, "p"); // a -> review_ready
		const applied = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		const aSha = present(applied.appliedCommitSha, "a applied sha");

		// b has NOT launched yet (apply does not launch); a separate advance does.
		expect(stepOf(present(h.store.get("p"), "p"), "b").status).toBe("pending");
		const c2 = advancePlan(h.store, h.deps, "p");
		const b = stepOf(c2, "b");
		expect(b.status).toBe("running");
		// b was cut from the ADVANCED tip (a's applied commit), so its worktree already contains a's
		// change -- this is the whole point of the plan-runner.
		expect(b.baseSha).toBe(aSha);
		const bWorktree = present(b.worktreePath, "b worktree");
		expect(readFileSync(join(bWorktree, "base.txt"), "utf-8")).toContain("from-a");

		// Settle + apply b: the integration branch now carries BOTH changes, end to end.
		h.finish(b.runId ?? "", { stopStatus: "converged" });
		advancePlan(h.store, h.deps, "p"); // b -> review_ready
		const appliedB = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "b", confirm: true });
		expect(appliedB.stepApplied).toBe(true);
		const stored = present(h.store.get("p"), "stored plan");
		expect(stored.status).toBe("completed");
		const integration = present(stored.integrationWorktree, "integration worktree");
		const content = readFileSync(join(integration, "base.txt"), "utf-8");
		expect(content).toContain("from-a");
		expect(content).toContain("from-b");
		expect(run(integration, ["rev-list", "--count", `${h.baseSha}..HEAD`]).trim()).toBe("2");
	});

	test("a refused apply is a whole-plan no-op: no commit, no applied, step stays review_ready", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		const integration = present(plan.integrationWorktree, "integration worktree");
		const headBefore = run(integration, ["rev-parse", "HEAD"]).trim();
		const conflictDeps: PlanEngineDeps = {
			...h.deps,
			applyWorkspace: (p) => ({
				confirmed: p.confirm,
				target: p.target,
				trackedFiles: ["base.txt"],
				appliesClean: false,
				applied: false,
				conflict: "synthetic conflict from applyRunWorkspace",
				untracked: [],
				untrackedConflicts: [],
				receiptsKept: true,
				note: "synthetic conflict",
			}),
			commit: () => {
				throw new Error("commit must not run after a refused apply");
			},
		};

		const outcome = applyPlanStep(h.store, conflictDeps, {
			planId: "p",
			stepId: "a",
			confirm: true,
		});
		expect(outcome.apply.appliesClean).toBe(false);
		expect(outcome.apply.conflict).toBeDefined();
		expect(outcome.apply.applied).not.toBe(true);
		expect(outcome.stepApplied).toBe(false);
		expect(outcome.appliedCommitSha).toBeUndefined();

		// No commit was made, and the step stays review_ready (the operator can resolve + retry).
		expect(run(integration, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("review_ready");
		expect(stored.integrationTipSha).toBe(h.baseSha);
	});

	test("refuses before apply when the integration worktree has unrelated dirty state", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		const integration = present(plan.integrationWorktree, "integration worktree");
		writeFileSync(join(integration, "operator-note.txt"), "unrelated local work\n");
		const headBefore = run(integration, ["rev-parse", "HEAD"]).trim();

		expect(() =>
			applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true }),
		).toThrow(/integration worktree .* has uncommitted changes/);

		expect(run(integration, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
		expect(readFileSync(join(integration, "base.txt"), "utf-8")).toBe("hello\n");
		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("review_ready");
		expect(stored.integrationTipSha).toBe(h.baseSha);
	});

	test("explicitly included untracked files are committed in the integration worktree", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		// The implementer also created a brand-new (untracked) file in the step worktree.
		const stepWorktree = present(stepOf(plan, "a").worktreePath, "step a worktree");
		writeFileSync(join(stepWorktree, "extra.txt"), "new file\n");

		// The dry run surfaces it as a candidate but never auto-applies it.
		const dry = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: false });
		expect(dry.apply.untracked).toContain("extra.txt");

		const outcome = applyPlanStep(h.store, h.deps, {
			planId: "p",
			stepId: "a",
			confirm: true,
			includeUntracked: ["extra.txt"],
		});
		expect(outcome.stepApplied).toBe(true);
		expect(outcome.apply.appliedUntracked).toContain("extra.txt");
		const integration = present(
			present(h.store.get("p"), "stored plan").integrationWorktree,
			"integration worktree",
		);
		// The untracked file is present AND committed (git add -A staged it into the step commit).
		expect(existsSync(join(integration, "extra.txt"))).toBe(true);
		expect(run(integration, ["status", "--porcelain"]).trim()).toBe("");
		expect(run(integration, ["show", "--stat", "HEAD"])).toContain("extra.txt");
	});

	test("refuses a no-op apply that would strand untracked-only work, instead of marking applied", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");
		// Turn the step into a NO-tracked-diff step that still has reviewable untracked work: restore
		// the tracked file to its base content, and add a brand-new untracked file.
		writeFileSync(join(stepWt, "base.txt"), "hello\n");
		writeFileSync(join(stepWt, "extra.txt"), "untracked work\n");
		const integration = present(plan.integrationWorktree, "integration worktree");
		const headBefore = run(integration, ["rev-parse", "HEAD"]).trim();

		// Apply WITHOUT including the untracked file: nothing would land in the integration worktree,
		// so it must be refused (not silently marked applied, which would unlock dependents).
		const outcome = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		expect(outcome.stepApplied).toBe(false);
		expect(outcome.appliedCommitSha).toBeUndefined();
		expect(outcome.note).toContain("extra.txt");

		// The step stays review_ready and the integration tip did not move.
		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("review_ready");
		expect(stored.integrationTipSha).toBe(h.baseSha);
		expect(run(integration, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);

		// Including the file DOES land + commit it -- the explicit path to land the work.
		const ok = applyPlanStep(h.store, h.deps, {
			planId: "p",
			stepId: "a",
			confirm: true,
			includeUntracked: ["extra.txt"],
		});
		expect(ok.stepApplied).toBe(true);
		expect(existsSync(join(integration, "extra.txt"))).toBe(true);
	});

	test("a truly empty step (no tracked diff, no untracked files) is a coherent no-op marked applied", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h);
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");
		// Restore the tracked file and leave nothing else: the step genuinely produced no diff.
		writeFileSync(join(stepWt, "base.txt"), "hello\n");
		const integration = present(plan.integrationWorktree, "integration worktree");
		const headBefore = run(integration, ["rev-parse", "HEAD"]).trim();

		const outcome = applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		expect(outcome.stepApplied).toBe(true);
		// No new commit: the step is applied at the unchanged tip (== base), and the branch did not grow.
		expect(outcome.appliedCommitSha).toBe(headBefore);
		const stored = present(h.store.get("p"), "stored plan");
		expect(stepOf(stored, "a").status).toBe("applied");
		expect(stored.integrationTipSha).toBe(headBefore);
		expect(run(integration, ["rev-list", "--count", `${h.baseSha}..HEAD`]).trim()).toBe("0");
	});
});

describe("cleanupPlan (real git)", () => {
	// Reach a completed plan: apply the single step, so every step is applied and the plan is terminal.
	function completedSingle(h: RealHarness): Plan {
		reviewReadySingle(h);
		applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		return present(h.store.get("p"), "stored plan");
	}

	test("dry run reports the integration + step worktrees and removes nothing", () => {
		const h = realHarness();
		const plan = completedSingle(h);
		expect(plan.status).toBe("completed");
		const integration = present(plan.integrationWorktree, "integration worktree");
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");

		const dry = cleanupPlan(h.store, h.deps, "p", false);
		expect(dry.available).toBe(true);
		expect(dry.confirmed).toBe(false);
		expect(dry.receiptsKept).toBe(true);
		expect(dry.targets.map((t) => t.id).sort()).toEqual(["a", "integration"]);
		expect(dry.appliedCommits).toBe(1); // the note warns the integration branch carries it

		// The receipt may report the plan root path (useful preview), but must NOT claim it was removed:
		// a dry run removes nothing.
		expect(dry.planRootPath).toBe(dirname(integration));
		expect(dry.planRootRemoved).not.toBe(true);

		// Nothing removed; no cleanedAt stamped.
		expect(existsSync(integration)).toBe(true);
		expect(existsSync(stepWt)).toBe(true);
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeUndefined();
	});

	test("confirm removes the plan-managed worktrees + branches but keeps the durable plan record", () => {
		const h = realHarness();
		const plan = completedSingle(h);
		const integration = present(plan.integrationWorktree, "integration worktree");
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");

		const res = cleanupPlan(h.store, h.deps, "p", true);
		expect(res.confirmed).toBe(true);
		expect(res.available).toBe(true);
		expect(res.receiptsKept).toBe(true);
		expect(res.targets.every((t) => t.removed === true)).toBe(true);

		// Worktrees and branches are gone.
		expect(existsSync(integration)).toBe(false);
		expect(existsSync(stepWt)).toBe(false);
		expect(
			realGit(["rev-parse", "--verify", "--quiet", "refs/heads/chit-plan/p/integration"], h.repo)
				.code,
		).not.toBe(0);
		expect(
			realGit(["rev-parse", "--verify", "--quiet", "refs/heads/chit-plan/p/steps/a"], h.repo).code,
		).not.toBe(0);

		// The now-empty plan parent directory (~/worktrees/chit/<planId>) is removed too, so a cleaned
		// plan leaves no empty litter (the dogfood wart this fixes). dirname(integration) is that root.
		expect(existsSync(dirname(integration))).toBe(false);
		// The receipt reports the parent cleanup outcome, so an operator can audit it without a shell
		// `test ! -e <root>`.
		expect(res.planRootPath).toBe(dirname(integration));
		expect(res.planRootRemoved).toBe(true);

		// The durable plan record survives, now stamped with cleanedAt.
		const stored = present(h.store.get("p"), "stored plan");
		expect(stored.cleanedAt).toBeDefined();
		expect(describePlan(stored, h.deps).cleanedAt).toBe(stored.cleanedAt);
		expect(stored.steps).toHaveLength(1);
		expect(stepOf(stored, "a").status).toBe("applied");
	});

	test("confirm removes the integration + every step worktree, branches, and the now-empty plan parent", () => {
		const h = realHarness();
		// A two-step chain (a -> b) so steps/ holds MORE than one step worktree: the nested layout that
		// left an empty plan parent behind before this fix. Drive both steps to applied -> plan completes.
		const started = startPlan(h.store, h.deps, {
			id: "p",
			cwd: h.repo,
			normalizedPlan: chainPlan(),
		});
		h.finish(stepOf(started, "a").runId ?? "", { stopStatus: "converged" });
		advancePlan(h.store, h.deps, "p"); // a -> review_ready
		applyPlanStep(h.store, h.deps, { planId: "p", stepId: "a", confirm: true });
		const c2 = advancePlan(h.store, h.deps, "p"); // launches b
		h.finish(stepOf(c2, "b").runId ?? "", { stopStatus: "converged" });
		advancePlan(h.store, h.deps, "p"); // b -> review_ready
		applyPlanStep(h.store, h.deps, { planId: "p", stepId: "b", confirm: true });
		const plan = present(h.store.get("p"), "stored plan");
		expect(plan.status).toBe("completed");

		const integration = present(plan.integrationWorktree, "integration worktree");
		const aWt = present(stepOf(plan, "a").worktreePath, "step a worktree");
		const bWt = present(stepOf(plan, "b").worktreePath, "step b worktree");
		const planParent = dirname(integration); // ~/worktrees/chit/<planId>
		const stepsDir = dirname(aWt); // ~/worktrees/chit/<planId>/steps

		const res = cleanupPlan(h.store, h.deps, "p", true);
		expect(res.targets.map((t) => t.id).sort()).toEqual(["a", "b", "integration"]);
		expect(res.targets.every((t) => t.removed === true)).toBe(true);

		// Every managed worktree is gone, the steps/ dir is gone, AND the now-empty plan parent is gone.
		expect(existsSync(integration)).toBe(false);
		expect(existsSync(aWt)).toBe(false);
		expect(existsSync(bWt)).toBe(false);
		expect(existsSync(stepsDir)).toBe(false);
		expect(existsSync(planParent)).toBe(false);
		// Branches removed.
		for (const ref of [
			"refs/heads/chit-plan/p/integration",
			"refs/heads/chit-plan/p/steps/a",
			"refs/heads/chit-plan/p/steps/b",
		]) {
			expect(realGit(["rev-parse", "--verify", "--quiet", ref], h.repo).code).not.toBe(0);
		}
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeDefined();
	});

	test("keeps a non-empty plan parent directory (an unrelated sibling survives cleanup)", () => {
		const h = realHarness();
		const plan = completedSingle(h);
		const integration = present(plan.integrationWorktree, "integration worktree");
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");
		const planParent = dirname(integration); // ~/worktrees/chit/<planId>
		// An unrelated file an operator dropped in the plan's worktree root: cleanup must not delete it,
		// and must not remove the now-non-empty root (only an EMPTY plan parent is litter to retire).
		const sentinel = join(planParent, "operator-note.txt");
		writeFileSync(sentinel, "do not delete\n");

		const res = cleanupPlan(h.store, h.deps, "p", true);
		expect(res.confirmed).toBe(true);
		expect(res.targets.every((t) => t.removed === true)).toBe(true);

		// The managed worktrees/branches are still removed...
		expect(existsSync(integration)).toBe(false);
		expect(existsSync(stepWt)).toBe(false);
		// ...but the non-empty parent and its unrelated file survive (empty-only removal).
		expect(existsSync(planParent)).toBe(true);
		expect(existsSync(sentinel)).toBe(true);
		expect(readFileSync(sentinel, "utf-8")).toBe("do not delete\n");
		// The receipt reports the same plan root path but planRootRemoved false: the stray file kept it.
		expect(res.planRootPath).toBe(planParent);
		expect(res.planRootRemoved).toBe(false);
		// Leaving the parent is best-effort litter cleanup, not a failure: the cleanup still completed.
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeDefined();
	});

	test("refuses (removes nothing) when a step is review_ready, even on confirm", () => {
		const h = realHarness();
		const { plan } = reviewReadySingle(h); // a is review_ready, NOT applied
		const integration = present(plan.integrationWorktree, "integration worktree");
		const stepWt = present(stepOf(plan, "a").worktreePath, "step a worktree");

		const res = cleanupPlan(h.store, h.deps, "p", true);
		expect(res.available).toBe(false);
		expect(res.confirmed).toBe(true);
		expect(present(res.refusal, "refusal").toLowerCase()).toContain("review_ready");

		// Nothing removed; the reviewable work is protected.
		expect(existsSync(integration)).toBe(true);
		expect(existsSync(stepWt)).toBe(true);
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeUndefined();
	});

	test("refuses (removes nothing) while a cancelled step's worker is still live", () => {
		const h = realHarness();
		const started = startPlan(h.store, h.deps, {
			id: "p",
			cwd: h.repo,
			normalizedPlan: chainPlan({ steps: [step("a")] }),
		});
		const integration = present(started.integrationWorktree, "integration worktree");
		const stepWt = present(stepOf(started, "a").worktreePath, "step a worktree");
		// Cancel the plan: the step is marked cancelled, but the job stays queued/running (the worker
		// has not exited and isStale is false), so it counts as a LIVE worker holding the worktree.
		const cancelled = cancelPlan(h.store, h.deps, "p");
		expect(cancelled.status).toBe("cancelled");

		const res = cleanupPlan(h.store, h.deps, "p", true);
		expect(res.available).toBe(false);
		expect(present(res.refusal, "refusal")).toContain("live worker");

		// Nothing removed; the in-flight worktree is protected from removal-under-a-live-worker.
		expect(existsSync(integration)).toBe(true);
		expect(existsSync(stepWt)).toBe(true);
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeUndefined();
	});

	test("a removal failure does NOT stamp cleanedAt (an idempotent re-run retires the rest)", () => {
		const h = realHarness();
		completedSingle(h);
		// Force every removal to fail; the plan must NOT be recorded as cleaned.
		const failingDeps: PlanEngineDeps = {
			...h.deps,
			removeWorktree: () => ({ ok: false, error: "git worktree remove failed: boom" }),
		};
		const res = cleanupPlan(h.store, failingDeps, "p", true);
		expect(res.confirmed).toBe(true);
		expect(res.available).toBe(true);
		expect(res.targets.every((t) => t.error !== undefined)).toBe(true);
		expect(res.cleanedAt).toBeUndefined();
		expect(res.note.toLowerCase()).toContain("not marked cleaned");
		// The record stays un-stamped, so a re-run is honest about there being work left.
		expect(present(h.store.get("p"), "stored plan").cleanedAt).toBeUndefined();
	});
});
