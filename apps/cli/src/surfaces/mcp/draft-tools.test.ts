import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILE_ID, type NormalizedProfile } from "@chit-run/core";
import type { BatchEngineDeps, LaunchJobParams } from "../../batches/engine.ts";
import { BatchStore } from "../../batches/store.ts";
import type { GitResult, GitRunner } from "../../batches/worktree.ts";
import type { LoopJobRecord } from "../../jobs/types.ts";
import type { LaunchPlanJobParams, PlanEngineDeps } from "../../plans/engine.ts";
import { PlanStore } from "../../plans/store.ts";
import { type DraftLaunchDeps, DraftLaunchRefused, runDraftLaunch } from "./draft-tools.ts";

// runDraftLaunch is the security boundary between a previewed draft and a real launch.
// These tests drive it with FAKE plan/batch engine deps (no real git, no spawned worker),
// so the gate is exercised end to end: a confirmed launch reaches the real
// launchNormalizedPlan / startBatch glue and a mismatch never does.

const PROFILES: Record<string, NormalizedProfile> = {
	[DEFAULT_PROFILE_ID]: { id: DEFAULT_PROFILE_ID, builtIn: true },
};

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let planLaunched: LaunchPlanJobParams[];
let batchLaunched: LaunchJobParams[];
let seq: number;

// A plain main-repo checkout: --git-common-dir is <cwd>/.git, so mainRepoOfWorktree
// resolves repo back to cwd (repo === callerCheckout for a non-linked launch).
function fakeGit(): GitRunner {
	return (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${cwd}\n`);
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${cwd}/.git\n`);
		if (args[0] === "rev-parse") {
			const ref = String(args[1] ?? "HEAD");
			return ok(`${ref.endsWith("-sha") ? ref : `${ref}-sha`}\n`);
		}
		return ok("");
	};
}

function jobRecord(
	p: {
		loopId: string;
		cwd: string;
		scope: string;
		task: string;
		maxIterations: number;
		worktree: LaunchPlanJobParams["worktree"];
	},
	jobId: string,
): LoopJobRecord {
	return {
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
	};
}

function makeDeps(): DraftLaunchDeps {
	const planJobs = new Map<string, LoopJobRecord>();
	const batchJobs = new Map<string, LoopJobRecord>();
	const git = fakeGit();
	const planDeps: PlanEngineDeps = {
		git,
		createIntegrationWorktree: (_repo, planId) => ({
			worktreePath: `/wt/${planId}/integration`,
			branch: `chit-plan/${planId}/integration`,
		}),
		createStepWorktree: (_repo, planId, stepId) => ({
			worktreePath: `/wt/${planId}/steps/${stepId}`,
			branch: `chit-plan/${planId}/steps/${stepId}`,
		}),
		launchJob: (p) => {
			const jobId = `pjob-${++seq}`;
			planJobs.set(jobId, jobRecord(p, jobId));
			planLaunched.push(p);
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => planJobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
		applyWorkspace: () => {
			throw new Error("applyWorkspace must not be reached in a launch test");
		},
		commit: () => {
			throw new Error("commit must not be reached in a launch test");
		},
		removeWorktree: () => {
			throw new Error("removeWorktree must not be reached in a launch test");
		},
		removeEmptyDir: () => {
			throw new Error("removeEmptyDir must not be reached in a launch test");
		},
		now: () => 1000,
	};
	const batchDeps: BatchEngineDeps = {
		git,
		createWorktree: (_repo, cid, tid) => ({
			worktreePath: `/wt/${cid}/${tid}`,
			branch: `chit-batch/${cid}/${tid}`,
		}),
		removeWorktree: () => ({ ok: true }),
		launchJob: (p) => {
			const jobId = `bjob-${++seq}`;
			batchJobs.set(jobId, jobRecord(p, jobId));
			batchLaunched.push(p);
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => batchJobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
		now: () => 1000,
	};
	return {
		profiles: PROFILES,
		planStoreFor: () => ({ store: new PlanStore(cwd), cwd }),
		planDeps,
		batchStoreFor: () => ({ store: new BatchStore(cwd), cwd }),
		batchDeps,
		genId: () => `gen-${++seq}`,
	};
}

const PLAN_DRAFT = {
	schema: 1,
	strategy: "plan",
	title: "Wire the feature",
	steps: [
		{ id: "scaffold", title: "Scaffold", body: "Create the module" },
		{ id: "impl", title: "Implement", body: "Do the work", codeDependsOn: ["scaffold"] },
	],
};

const BATCH_DRAFT = {
	schema: 1,
	strategy: "batch",
	title: "Touch two areas",
	steps: [
		{ id: "api", title: "API", body: "edit api", claimedPaths: ["src/api/"] },
		{
			id: "web",
			title: "Web",
			body: "edit web",
			claimedPaths: ["src/web.ts"],
			orderDependsOn: ["api"],
		},
	],
};

function dryApprove(
	draft: string | Record<string, unknown>,
	deps = makeDeps(),
	opts: { baseBranch?: string } = {},
): { approvalHash: string; base: { ref: string; sha: string } } {
	const dry = runDraftLaunch({ draft, cwd, ...opts }, deps);
	expect(dry.launched).toBe(false);
	if (dry.launched) throw new Error("expected dry-run approval");
	return { approvalHash: dry.approvalHash, base: dry.base };
}

beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-draft-launch-cwd-")));
	stateDir = mkdtempSync(join(tmpdir(), "chit-draft-launch-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	planLaunched = [];
	batchLaunched = [];
	seq = 0;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

describe("runDraftLaunch dry run (confirm omitted/false)", () => {
	test("returns the preview, resolved base, approval hash, and launches nothing", () => {
		const deps = makeDeps();
		const result = runDraftLaunch({ draft: PLAN_DRAFT, cwd }, deps);
		expect(result.launched).toBe(false);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.strategy).toBe("plan");
		expect(result.preview.status).toBe("preview_ready");
		expect(result.base).toEqual({ ref: "HEAD", sha: "HEAD-sha" });
		expect(result.approvalHash).toMatch(/^[0-9a-f]{64}$/);
		// No plan was started and no job launched.
		expect(planLaunched).toHaveLength(0);
		expect(new PlanStore(cwd).list()).toHaveLength(0);
	});

	test("confirm:false is also a dry run", () => {
		const deps = makeDeps();
		const result = runDraftLaunch({ draft: BATCH_DRAFT, confirm: false, cwd }, deps);
		expect(result.launched).toBe(false);
		expect(batchLaunched).toHaveLength(0);
	});

	test("the dry-run hash includes the resolved base", () => {
		const deps = makeDeps();
		const dry = runDraftLaunch({ draft: PLAN_DRAFT, cwd }, deps);
		const otherBase = runDraftLaunch({ draft: PLAN_DRAFT, cwd, baseBranch: "feature" }, deps);
		expect(dry.launched).toBe(false);
		expect(otherBase.launched).toBe(false);
		if (dry.launched || otherBase.launched) throw new Error("expected dry runs");
		expect(dry.approvalHash).not.toBe(otherBase.approvalHash);
		expect(otherBase.base).toEqual({ ref: "feature", sha: "feature-sha" });
	});
});

describe("runDraftLaunch confirmed plan launch", () => {
	test("launches through the plan engine only with a matching approval hash", () => {
		const deps = makeDeps();
		const approved = dryApprove(PLAN_DRAFT, deps);
		const result = runDraftLaunch(
			{ draft: PLAN_DRAFT, confirm: true, approvalHash: approved.approvalHash, cwd },
			deps,
		);
		expect(result.launched).toBe(true);
		if (!result.launched || result.strategy !== "plan") throw new Error("expected a plan launch");
		expect(result.base).toEqual(approved.base);
		// The same plan view chit_plan_start returns, leading with plan_id.
		expect(result.view.plan_id).toBeDefined();
		expect(result.view.steps.map((s) => s.id)).toEqual(["scaffold", "impl"]);
		// Exactly the first step launched (the dependent waits).
		expect(planLaunched).toHaveLength(1);
		expect(planLaunched[0]?.worktree.baseSha).toBe("HEAD-sha");
		expect(new PlanStore(cwd).list()).toHaveLength(1);
	});

	test("a non-matching approval hash is refused and launches nothing", () => {
		const deps = makeDeps();
		expect(() =>
			runDraftLaunch({ draft: PLAN_DRAFT, confirm: true, approvalHash: "deadbeef", cwd }, deps),
		).toThrow(DraftLaunchRefused);
		expect(planLaunched).toHaveLength(0);
		expect(new PlanStore(cwd).list()).toHaveLength(0);
	});

	test("confirm with no approval hash is refused", () => {
		const deps = makeDeps();
		expect(() => runDraftLaunch({ draft: PLAN_DRAFT, confirm: true, cwd }, deps)).toThrow(
			/requires approval_hash/,
		);
		expect(planLaunched).toHaveLength(0);
	});
});

describe("runDraftLaunch confirmed batch launch", () => {
	test("launches through the batch engine only with a matching approval hash", () => {
		const deps = makeDeps();
		const approved = dryApprove(BATCH_DRAFT, deps, { baseBranch: "feature" });
		const result = runDraftLaunch(
			{
				draft: BATCH_DRAFT,
				confirm: true,
				approvalHash: approved.approvalHash,
				cwd,
				baseBranch: "feature",
			},
			deps,
		);
		expect(result.launched).toBe(true);
		if (!result.launched || result.strategy !== "batch") throw new Error("expected a batch launch");
		expect(result.base).toEqual({ ref: "feature", sha: "feature-sha" });
		expect(result.view.tasks.map((t) => t.id).sort()).toEqual(["api", "web"]);
		// Only the independent task launches in the first wave; the gated one waits.
		expect(batchLaunched).toHaveLength(1);
		expect(batchLaunched[0]?.worktree.baseSha).toBe("feature-sha");
		expect(new BatchStore(cwd).list()).toHaveLength(1);
	});

	test("a non-matching approval hash is refused and launches nothing", () => {
		const deps = makeDeps();
		expect(() =>
			runDraftLaunch(
				{
					draft: BATCH_DRAFT,
					confirm: true,
					approvalHash: dryApprove(PLAN_DRAFT).approvalHash,
					cwd,
				},
				deps,
			),
		).toThrow(DraftLaunchRefused);
		expect(batchLaunched).toHaveLength(0);
		expect(new BatchStore(cwd).list()).toHaveLength(0);
	});
});

describe("runDraftLaunch refuses a changed draft with an old approval hash", () => {
	test("editing a step body after approval invalidates the old hash", () => {
		const deps = makeDeps();
		const oldHash = dryApprove(PLAN_DRAFT, deps).approvalHash;
		const changed = {
			...PLAN_DRAFT,
			steps: [PLAN_DRAFT.steps[0], { ...PLAN_DRAFT.steps[1], body: "Do something ELSE entirely" }],
		};
		expect(() =>
			runDraftLaunch({ draft: changed, confirm: true, approvalHash: oldHash, cwd }, deps),
		).toThrow(/does not match/);
		expect(planLaunched).toHaveLength(0);
		expect(new PlanStore(cwd).list()).toHaveLength(0);
	});

	test("changing the base after approval invalidates the old hash", () => {
		const deps = makeDeps();
		const oldHash = dryApprove(PLAN_DRAFT, deps, { baseBranch: "main" }).approvalHash;
		expect(() =>
			runDraftLaunch(
				{ draft: PLAN_DRAFT, confirm: true, approvalHash: oldHash, cwd, baseBranch: "feature" },
				deps,
			),
		).toThrow(/does not match/);
		expect(planLaunched).toHaveLength(0);
		expect(new PlanStore(cwd).list()).toHaveLength(0);
	});
});
