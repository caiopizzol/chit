import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPlan, PlanStep } from "@chit-run/core";
import type { GitRunner } from "../batches/worktree.ts";
import type { LoopJobRecord } from "../jobs/types.ts";
import { repoKey } from "../loops/location.ts";
import {
	advancePlan,
	cancelPlan,
	describePlan,
	type LaunchPlanJobParams,
	listPlans,
	type PlanEngineDeps,
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
		loopDetail: () => ({ changedFiles: ["f.ts"], workspaceWarnings: [] }),
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

	// nextAction is surfaced publicly through describePlan, so in this slice it must never
	// instruct the operator to apply via chit_plan_advance or clean with chit_plan_cleanup --
	// neither the gated apply nor the cleanup tool is wired yet.
	test("a review_ready (ready_for_apply) plan never instructs apply-via-advance or cleanup", () => {
		const c0 = startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		jobs.finish(stepOf(c0, "a").runId ?? "", { stopStatus: "converged" });
		const c1 = advancePlan(store, deps, "p1"); // a -> review_ready
		const view = describePlan(c1, deps);
		expect(view.status).toBe("ready_for_apply");
		// The only forward move (apply) is not wired, so advance must not be suggested here, and
		// cleanup does not exist yet.
		expect(view.nextAction).not.toContain("chit_plan_advance");
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
		// It still points at the read-only path that DOES exist.
		expect(view.nextAction).toContain("chit_plan_status");
	});

	test("a cancelled plan never instructs chit_plan_cleanup", () => {
		startPlan(store, deps, { id: "p1", cwd, normalizedPlan: chainPlan() });
		const view = describePlan(cancelPlan(store, deps, "p1"), deps);
		expect(view.status).toBe("cancelled");
		expect(view.nextAction).not.toContain("chit_plan_cleanup");
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
