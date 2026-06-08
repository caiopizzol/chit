import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequiredCheck } from "@chit-run/core";
import type { LoopJobRecord } from "../jobs/types.ts";
import {
	advanceBatch,
	type BatchEngineDeps,
	batchWaitState,
	cancelBatch,
	cleanupBatch,
	describeBatch,
	type LaunchJobParams,
	listBatches,
	startBatch,
	summarizeBatch,
} from "./engine.ts";
import type { TaskInput } from "./plan.ts";
import { BatchStore } from "./store.ts";
import type { Batch, BatchTask } from "./types.ts";
import type { GitRunner } from "./worktree.ts";

// A fake job world: launchJob registers a running job; tests then flip a job's
// state to simulate the background worker finishing.
class FakeJobs {
	jobs = new Map<string, LoopJobRecord>();
	launched: Array<{
		jobId: string;
		cwd: string;
		manifestPath?: string;
		scope: string;
		requiredChecks?: RequiredCheck[];
		callTimeoutMs?: number;
		worktree: LaunchJobParams["worktree"];
	}> = [];
	cancelled: string[] = [];
	private seq = 0;

	// Typed against the real dep contract so the fake cannot drift from what the engine passes.
	launch = (p: LaunchJobParams): { jobId: string; loopId: string } => {
		const jobId = `job-${++this.seq}`;
		// Real launchConvergeJob creates jobs as "queued"; the worker flips them to
		// "running". Mirror that here so the reconcile path is tested against reality
		// (a just-launched queued job must NOT be reconciled as failed). It also spreads
		// the worktree metadata onto the record (worktreePath/branch/baseSha/repo/
		// callerCheckout) -- mirror that so a launched batch task is applyable like real.
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
			manifestPath: p.manifestPath,
			scope: p.scope,
			requiredChecks: p.requiredChecks,
			callTimeoutMs: p.callTimeoutMs,
			worktree: p.worktree,
		});
		return { jobId, loopId: p.loopId };
	};
	get = (jobId: string): LoopJobRecord | undefined => this.jobs.get(jobId);
	cancel = (jobId: string): void => {
		this.cancelled.push(jobId);
	};
	// Test helper: settle a job to a terminal state.
	finish(jobId: string, over: Partial<LoopJobRecord>): void {
		const j = this.jobs.get(jobId);
		if (j) this.jobs.set(jobId, { ...j, state: "completed", iterationsCompleted: 1, ...over });
	}
}

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: BatchStore;
let jobs: FakeJobs;
let deps: BatchEngineDeps;
let wtSeq = 0;
let removedWorktrees: Array<{ repo: string; worktreePath: string; branch: string }> = [];

const fakeGit: GitRunner = (args) => {
	if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
		return { code: 0, stdout: `${cwd}\n`, stderr: "" };
	}
	// A plain main-repo checkout: the shared git common dir is <toplevel>/.git, so
	// mainRepoOfWorktree resolves back to cwd -- repo === callerCheckout for a non-linked
	// launch. cwd is realpath'd in beforeEach so realpathSync inside the helper is a no-op
	// and this stays stable across platforms (macOS /var -> /private/var).
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
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-eng-cwd-")));
	stateDir = mkdtempSync(join(tmpdir(), "chit-eng-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new BatchStore(cwd);
	jobs = new FakeJobs();
	wtSeq = 0;
	removedWorktrees = [];
	deps = {
		git: fakeGit,
		createWorktree: (_repo, cid, tid) => ({
			worktreePath: `/wt/${cid}/${tid}-${++wtSeq}`,
			branch: `chit-batch/${cid}/${tid}`,
		}),
		removeWorktree: (repo, worktreePath, branch) => {
			removedWorktrees.push({ repo, worktreePath, branch });
			return { ok: true };
		},
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

function task(id: string, over: Partial<TaskInput> = {}): TaskInput {
	return { id, title: id, body: `do ${id}`, claimedPaths: [`${id}/**`], ...over };
}

// Guard helper: assert-present without a non-null assertion (keeps the lint clean).
function present<T>(v: T | undefined, what: string): T {
	if (v === undefined) throw new Error(`expected ${what} to be present`);
	return v;
}
const firstJob = () => present(jobs.launched[0], "first launched job").jobId;
const taskOf = (c: Batch, id: string): BatchTask =>
	present(
		c.tasks.find((t) => t.id === id),
		`task ${id}`,
	);

describe("startBatch", () => {
	test("launches the initial wave of independent tasks up to the cap", () => {
		const c = startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b"), task("c")],
			maxParallel: 2,
		});
		const running = c.tasks.filter((t) => t.status === "running");
		expect(running.map((t) => t.id)).toEqual(["a", "b"]);
		expect(c.tasks.find((t) => t.id === "c")?.status).toBe("pending");
		expect(jobs.launched).toHaveLength(2);
		expect(c.status).toBe("running");
		// worktree + job ids recorded on the launched tasks
		expect(running.every((t) => t.worktreePath && t.branch && t.jobId)).toBe(true);
	});

	test("records the task's managed worktree on the launched job (so chit_apply can resolve it)", () => {
		// The fix: launchWave must pass worktreePath/branch/baseSha/repo/callerCheckout through
		// launchJob onto the job record, mirroring the single-run background path -- otherwise
		// resolveRunWorkspace finds nothing and chit_apply misreports the task as in_place.
		const c = startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a")],
			maxParallel: 1,
		});
		const a = taskOf(c, "a");
		const aWorktree = present(a.worktreePath, "task a worktreePath");
		const aBranch = present(a.branch, "task a branch");
		// The metadata launchJob RECEIVED: the task's own worktree + the batch's base/repo
		// (every task worktree is cut from c.baseSha at c.repo; c.repo is the launching checkout).
		const launched = present(jobs.launched.at(-1), "launched a");
		expect(launched.worktree).toEqual({
			worktreePath: aWorktree,
			branch: aBranch,
			baseSha: c.baseSha,
			repo: c.repo,
			callerCheckout: c.repo,
		});
		// And it landed on the JOB RECORD -- the exact fields resolveRunWorkspace reads to make a
		// batch task applyable (and that partialWorkView gates on for a failed task).
		const job = present(jobs.get(launched.jobId), "job record");
		expect(job.worktreePath).toBe(aWorktree);
		expect(job.baseSha).toBe(c.baseSha);
		expect(job.callerCheckout).toBe(c.repo);
	});

	test("threads the launching checkout as the task worktree tooling source", () => {
		const toolingSources: string[] = [];
		const capturing: BatchEngineDeps = {
			...deps,
			createWorktree: (repo, cid, tid, sha, toolingSource) => {
				toolingSources.push(toolingSource);
				return deps.createWorktree(repo, cid, tid, sha, toolingSource);
			},
		};
		const c = startBatch(store, capturing, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b")],
			maxParallel: 2,
		});

		// Batch task worktrees run checks too, so they need the same launch-checkout tooling link as
		// single-run and plan-step worktrees. For a main-repo launch, callerCheckout === cwd.
		const callerCheckout = present(c.callerCheckout, "caller checkout");
		expect(toolingSources).toEqual([callerCheckout, callerCheckout]);
		expect(c.callerCheckout).toBe(cwd);
	});

	test("resolves the per-task manifest override (task > batch > default)", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			manifestPath: "/camp.json",
			tasks: [task("a", { manifestPath: "/task.json" }), task("b")],
			maxParallel: 2,
		});
		const byScope = Object.fromEntries(jobs.launched.map((l) => [l.scope, l.manifestPath]));
		expect(byScope["batch-c1-a"]).toBe("/task.json"); // task override
		expect(byScope["batch-c1-b"]).toBe("/camp.json"); // batch default
	});

	test("a dependent task does not launch until its dependency is review_ready", () => {
		const c = startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		expect(c.tasks.find((t) => t.id === "a")?.status).toBe("running");
		expect(c.tasks.find((t) => t.id === "b")?.status).toBe("pending");
		expect(jobs.launched).toHaveLength(1);
	});
});

// Scenario 5 (docs/investigation-batch-recovery-0.32.md): a batch must anchor its durable
// cleanup on the MAIN repo that owns the shared .git, NOT the launching checkout, so task
// worktrees are never stranded when a linked-worktree launcher is removed before cleanup.
// startBatch splits `repo` (main repo, via mainRepoOfWorktree) from `callerCheckout`
// (launching checkout, via repoToplevel), mirroring the single-run prepareRunWorkspace.
describe("durable cleanup anchor: repo (main repo) vs callerCheckout (launching checkout)", () => {
	// A scripted GitRunner for a launch from a linked worktree: --show-toplevel is the launching
	// checkout, --git-common-dir resolves to the main repo's shared .git (<main>/.git -> <main>).
	// Fake absolute paths so realpathSync inside mainRepoOfWorktree throws and falls back to the
	// joined value (deterministic, no real fs). Optionally records the cwd each `rev-parse <ref>`
	// ran in, to pin where baseSha is resolved.
	function scriptedGit(opts: {
		toplevel: string;
		commonDir: string;
		revParseCwds?: string[];
	}): GitRunner {
		return (args, gitCwd) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				return { code: 0, stdout: `${opts.toplevel}\n`, stderr: "" };
			}
			if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
				return { code: 0, stdout: `${opts.commonDir}\n`, stderr: "" };
			}
			if (args[0] === "rev-parse") {
				opts.revParseCwds?.push(gitCwd);
				return { code: 0, stdout: "basesha\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
	}

	test("a linked-worktree launch anchors repo on the main repo, callerCheckout on the launcher (distinct)", () => {
		// Launch from /wt/feature (a linked worktree) whose shared .git lives at /main/.git. repo
		// must resolve to the durable main repo (/main), callerCheckout to the launching checkout
		// (/wt/feature). Against today's code BOTH come back /wt/feature and this fails.
		const git = scriptedGit({ toplevel: "/wt/feature", commonDir: "/main/.git" });
		const c = startBatch(
			store,
			{ ...deps, git },
			{
				id: "c1",
				cwd,
				tasks: [task("a")],
				maxParallel: 1,
			},
		);
		// The batch record stores BOTH, distinct.
		expect(c.repo).toBe("/main");
		expect(c.callerCheckout).toBe("/wt/feature");
		// And both reach launchJob distinctly: cleanup will anchor on /main, apply targets /wt/feature.
		const launched = present(jobs.launched.at(-1), "launched a");
		expect(launched.worktree.repo).toBe("/main");
		expect(launched.worktree.callerCheckout).toBe("/wt/feature");
	});

	test("a main-repo launch keeps repo === callerCheckout (the fix is a no-op for the common path)", () => {
		// Launched from the main repo itself: --show-toplevel and the common-dir parent are both /main.
		const git = scriptedGit({ toplevel: "/main", commonDir: "/main/.git" });
		const c = startBatch(
			store,
			{ ...deps, git },
			{
				id: "c1",
				cwd,
				tasks: [task("a")],
				maxParallel: 1,
			},
		);
		expect(c.repo).toBe("/main");
		expect(c.callerCheckout).toBe("/main");
		const launched = present(jobs.launched.at(-1), "launched a");
		expect(launched.worktree.repo).toBe("/main");
		expect(launched.worktree.callerCheckout).toBe("/main");
	});

	test("baseSha resolves against the launching checkout, never the main repo", () => {
		// HARD invariant: splitting repo (main) from callerCheckout (launcher) must NOT move the
		// base. The default HEAD still comes from the launcher's HEAD -- resolving HEAD in the main
		// repo would silently batch a feature-branch launch off the wrong base.
		const revParseCwds: string[] = [];
		const git = scriptedGit({ toplevel: "/wt/feature", commonDir: "/main/.git", revParseCwds });
		startBatch(
			store,
			{ ...deps, git },
			{
				id: "c1",
				cwd,
				tasks: [task("a")],
				maxParallel: 1,
			},
		);
		// The base ref was resolved from the launching checkout, not the main repo.
		expect(revParseCwds).toContain("/wt/feature");
		expect(revParseCwds).not.toContain("/main");
	});

	test("a pre-split batch record (no callerCheckout) falls back to repo when a later wave launches", () => {
		// A batch created before this fix has `repo` but no `callerCheckout`. When a dependent
		// launches on a later advance (resume after upgrade), launchWave must fall back to repo
		// (the ?? path), never forward an undefined callerCheckout onto the job.
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 1,
		});
		// Strip callerCheckout off the stored batch to simulate a pre-fix record.
		store.update("c1", (b) => {
			const pre: Batch = { ...b };
			delete pre.callerCheckout;
			return pre;
		});
		expect(present(store.get("c1"), "batch c1").callerCheckout).toBeUndefined();
		// a converges so the dependent b launches in the next wave.
		jobs.finish(firstJob(), { stopStatus: "converged" });
		const c = advanceBatch(store, deps, "c1");
		expect(taskOf(c, "b").status).toBe("running");
		const launchedB = present(jobs.launched.at(-1), "launched b");
		expect(launchedB.worktree.callerCheckout).toBe(c.repo); // fell back to repo, not undefined
	});

	test("cleanup anchors removal on the durable main repo, not the launching (linked) checkout", () => {
		// End to end: a batch launched from a linked worktree cleans up from the main repo, so even
		// if the launching checkout were removed first, `git worktree remove` runs from /main (which
		// owns the shared .git) and no worktree is stranded. Against today's code existing.repo would
		// be /wt/feature and removal would target the (possibly deleted) launcher.
		const git = scriptedGit({ toplevel: "/wt/feature", commonDir: "/main/.git" });
		const linkedDeps = { ...deps, git };
		startBatch(store, linkedDeps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, linkedDeps, "c1"); // a -> review_ready, batch ready_for_review
		cleanupBatch(store, linkedDeps, "c1", { confirm: true });
		expect(removedWorktrees).toHaveLength(1);
		expect(present(removedWorktrees[0], "removed entry").repo).toBe("/main");
	});
});

describe("advanceBatch", () => {
	test("reconciles a converged job to review_ready and launches the dependent", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		// a's job converges
		jobs.finish(firstJob(), {
			stopStatus: "converged",
			lastVerdict: "proceed",
			auditRefs: ["r1"],
		});
		const c = advanceBatch(store, deps, "c1");
		const a = taskOf(c, "a");
		const b = taskOf(c, "b");
		expect(a.status).toBe("review_ready");
		expect(a.result).toMatchObject({
			stopStatus: "converged",
			changedFiles: ["f.ts"],
			auditRefs: ["r1"],
		});
		expect(b.status).toBe("running"); // launched now that a is review_ready
	});

	test("a non-converged job (blocked / needs-decision / max-iterations) -> needs_attention, not failed", () => {
		// These are review judgments, not execution failures: the agents completed but
		// did not produce clean mergeable work. The task needs a human decision, carries
		// no error, and does NOT proceed its dependents (only review_ready satisfies).
		for (const stop of ["blocked", "needs-decision", "max-iterations"] as const) {
			startBatch(store, deps, {
				id: `c-${stop}`,
				cwd,
				tasks: [task("a"), task("b", { dependencies: ["a"] })],
				maxParallel: 2,
			});
			const jobId = present(jobs.launched.at(-1), `${stop} launched job`).jobId;
			jobs.finish(jobId, { stopStatus: stop });
			const c = advanceBatch(store, deps, `c-${stop}`);
			expect(taskOf(c, "a").status).toBe("needs_attention");
			expect(taskOf(c, "a").error).toBeUndefined(); // not an error
			expect(taskOf(c, "a").result?.stopStatus).toBe(stop);
			expect(taskOf(c, "b").status).toBe("pending"); // dependent does not proceed
			expect(c.status).toBe("needs_human");
		}
	});

	test("a genuinely failed job (manifest threw / ok:false) -> failed with an error", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { state: "failed", failure: "step exploded" });
		const c = advanceBatch(store, deps, "c1");
		expect(taskOf(c, "a").status).toBe("failed");
		expect(taskOf(c, "a").error).toContain("step exploded");
	});

	test("advance immediately after start does NOT fail a just-launched queued job", () => {
		// Regression: a freshly launched job is "queued" (worker not yet running).
		// Reconcile must treat queued as in-flight, not terminal, or a valid batch
		// self-fails on the first advance.
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		const c = advanceBatch(store, deps, "c1"); // jobs still queued
		expect(c.tasks.every((t) => t.status === "running")).toBe(true);
		expect(c.status).toBe("running");
	});

	test("batch loop ids are globally unique (batch-namespaced, not bare task id)", () => {
		startBatch(store, deps, { id: "camp-uuid", cwd, tasks: [task("docs")], maxParallel: 1 });
		const job = jobs.get(firstJob());
		expect(job?.loopId).toBe("camp-uuid-docs"); // not just "docs"
	});

	test("a stale running job is settled failed", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		deps.isStale = () => true; // worker went dark
		const c = advanceBatch(store, deps, "c1");
		expect(c.tasks[0]?.status).toBe("failed");
		expect(c.tasks[0]?.error).toMatch(/stale/);
	});

	test("all converged -> ready_for_review", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		for (const l of jobs.launched) jobs.finish(l.jobId, { stopStatus: "converged" });
		const c = advanceBatch(store, deps, "c1");
		expect(c.status).toBe("ready_for_review");
		expect(c.tasks.every((t) => t.status === "review_ready")).toBe(true);
	});
});

describe("describeBatch is read-only", () => {
	test("does not launch or mutate; reports nextAction", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		const launchedBefore = jobs.launched.length;
		jobs.finish(firstJob(), { stopStatus: "converged" });
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		// describe launched nothing even though a is now reconcilable + b runnable
		expect(jobs.launched.length).toBe(launchedBefore);
		expect(view.nextAction).toMatch(/chit_batch_advance/);
		// a's task status on disk is still "running" (describe did not reconcile)
		expect(store.get("c1")?.tasks.find((t) => t.id === "a")?.status).toBe("running");
	});
});

describe("needs_attention surfacing", () => {
	test("needs_human nextAction names the needs_attention task, keeps review_ready reviewable", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "needs-decision" });
		advanceBatch(store, deps, "c1"); // a -> needs_attention, batch -> needs_human
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(view.status).toBe("needs_human");
		expect(view.nextAction).toContain("need attention");
		expect(view.nextAction).toContain("review_ready tasks");
	});

	test("a failed task does not let the headline read ready_for_review; nextAction names it", () => {
		// Regression for the masking bug: task A fails (e.g. a reviewer/adapter timeout) while
		// task B converges. The batch must NOT headline ready_for_review (verdict integrity) --
		// it is needs_human, the failed task is named, and the clean sibling stays reviewable.
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		const ja = present(jobs.launched[0], "launched a").jobId;
		const jb = present(jobs.launched[1], "launched b").jobId;
		jobs.finish(ja, { state: "failed", failure: "codex exec timed out after 900000ms" });
		jobs.finish(jb, { stopStatus: "converged" });
		advanceBatch(store, deps, "c1");
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(view.status).toBe("needs_human"); // NOT ready_for_review (the masking bug)
		expect(view.tasks.find((t) => t.id === "a")?.status).toBe("failed");
		expect(view.tasks.find((t) => t.id === "b")?.status).toBe("review_ready");
		expect(view.nextAction).toContain("failed during execution");
		expect(view.nextAction).toContain("review_ready tasks");
	});

	test("a failed task surfaces partialWork (uncommitted worktree diff) the timeout left behind", () => {
		// The exact #100-followup bug: the implementer timed out at iteration 0, so changedFiles is
		// empty, but the worktree has real uncommitted work. The view must surface it, not hide it.
		deps.loopDetail = () => ({
			changedFiles: [], // no completed iteration
			workspaceWarnings: [],
			partialWork: {
				partialWorkPresent: true,
				dirtyFiles: ["server.ts", "tests.ts"],
				insertions: 110,
				deletions: 24,
			},
		});
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), {
			state: "failed",
			failure: 'manifest run failed at step "implement": claude --print timed out after 900000ms',
		});
		advanceBatch(store, deps, "c1");
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const a = view.tasks.find((t) => t.id === "a");
		expect(a?.status).toBe("failed");
		expect(a?.changedFiles).toEqual([]); // still empty (no iteration)...
		expect(a?.partialWork?.files).toEqual(["server.ts", "tests.ts"]); // ...but the work is surfaced
		expect(a?.partialWork?.diffStat).toBe("2 file(s), +110 -24");
		expect(a?.partialWork?.note).toContain("timed out after 15m");
	});

	test("a REVIEW-step timeout attributes the partialWork note to the reviewer, not the implementer", () => {
		// The Task B bug end to end: the implementer finished and produced a file, then the
		// reviewer timed out (a wedge / inherited long timeout). The recorded failure is step
		// "review", so the partial-work note must NOT blame the implementer (it did its job).
		deps.loopDetail = () => ({
			changedFiles: [],
			workspaceWarnings: [],
			partialWork: {
				partialWorkPresent: true,
				dirtyFiles: ["BATCH-TIMEOUT-SMOKE.md"],
				insertions: 1,
				deletions: 0,
			},
		});
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), {
			state: "failed",
			failure: 'manifest run failed at step "review": codex exec timed out after 600000ms',
		});
		advanceBatch(store, deps, "c1");
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const a = view.tasks.find((t) => t.id === "a");
		expect(a?.partialWork?.files).toEqual(["BATCH-TIMEOUT-SMOKE.md"]);
		expect(a?.partialWork?.note).toContain("reviewer timed out after 10m");
		expect(a?.partialWork?.note).not.toContain("The implementer timed out"); // the fixed bug
	});

	test("summarizeBatch counts needs_attention separately from failed", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "blocked" });
		advanceBatch(store, deps, "c1");
		const summary = summarizeBatch(present(store.get("c1"), "batch c1"));
		expect(summary.needsAttention).toBe(1);
		expect(summary.failed).toBe(0);
		expect(summary.reviewReady).toBe(0);
	});
});

describe("required checks cascade (task beats batch, reaching the snapshot boundary)", () => {
	// The engine cannot prove "batch beats manifest" -- it never loads manifests; that
	// fallback is launchConvergeJob's snapshot boundary (covered by pickRequiredChecks +
	// the worker snapshot test). Here we prove task beats batch and the override REACHES
	// launchJob.
	const TASKCHK: RequiredCheck = { command: "bun", args: ["test"] };
	const BATCHCHK: RequiredCheck = { command: "make", args: ["check"] };

	test("startBatch persists batch-level requiredChecks", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a")],
			maxParallel: 1,
			requiredChecks: [BATCHCHK],
		});
		expect(store.get("c1")?.requiredChecks).toEqual([BATCHCHK]);
	});

	test("a task's requiredChecks beat the batch's, and reach launchJob", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a", { requiredChecks: [TASKCHK] })],
			maxParallel: 1,
			requiredChecks: [BATCHCHK],
		});
		expect(jobs.launched.at(-1)?.requiredChecks).toEqual([TASKCHK]); // task wins, not batch
	});

	test("a task without its own checks gets the batch's at launch", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a")],
			maxParallel: 1,
			requiredChecks: [BATCHCHK],
		});
		expect(jobs.launched.at(-1)?.requiredChecks).toEqual([BATCHCHK]);
	});
});

describe("call-timeout cascade (task beats batch, reaching launchJob)", () => {
	// Same shape as the required-checks cascade: the engine proves task beats batch and
	// the effective value REACHES launchJob (which forwards it to the converge job, where
	// buildExecute applies it to every adapter -- covered by converge.test.ts).

	test("startBatch persists the batch-level callTimeoutMs", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a")],
			maxParallel: 1,
			callTimeoutMs: 600_000,
		});
		expect(store.get("c1")?.callTimeoutMs).toBe(600_000);
	});

	test("a task's callTimeoutMs beats the batch's, and reaches launchJob", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a", { callTimeoutMs: 120_000 })],
			maxParallel: 1,
			callTimeoutMs: 600_000,
		});
		expect(jobs.launched.at(-1)?.callTimeoutMs).toBe(120_000); // task wins, not batch
	});

	test("a task without its own callTimeoutMs gets the batch's at launch", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a")],
			maxParallel: 1,
			callTimeoutMs: 600_000,
		});
		expect(jobs.launched.at(-1)?.callTimeoutMs).toBe(600_000);
	});

	test("no override anywhere -> launchJob gets no callTimeoutMs (agent config / default stands)", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		expect(jobs.launched.at(-1)?.callTimeoutMs).toBeUndefined();
	});
});

describe("live verification surfacing (before reconcile)", () => {
	// The worker caches lastVerdict/lastVerification/lastVerificationSource on the job each
	// iteration. chit_batch_status must show them while the task is still "running" -- it
	// should not wait for chit_batch_advance to copy the final values into t.result.
	test("a mid-loop running task surfaces the live job's last verdict + verification", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		const jobId = firstJob();
		const j = present(jobs.jobs.get(jobId), "launched job");
		// One iteration done, still looping (a revise round chit verified itself).
		jobs.jobs.set(jobId, {
			...j,
			state: "running",
			iterationsCompleted: 1,
			lastVerdict: "revise",
			lastVerification: "failed",
			lastVerificationSource: "chit",
		});
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const t = present(
			view.tasks.find((x) => x.id === "a"),
			"task a view",
		);
		expect(t.status).toBe("running");
		expect(t.lastVerdict).toBe("revise");
		expect(t.lastVerification).toBe("failed");
		expect(t.lastVerificationSource).toBe("chit");
	});

	test("a finished-but-unreconciled task still surfaces the job's verification", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		// The job finished and cached its verification, but advance has not reconciled it,
		// so the task is still "running" with no t.result. The view must show what the job
		// recorded, not a blank.
		jobs.finish(firstJob(), {
			lastVerdict: "proceed",
			lastVerification: "passed",
			lastVerificationSource: "chit",
			stopStatus: "converged",
		});
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const t = present(
			view.tasks.find((x) => x.id === "a"),
			"task a view",
		);
		expect(t.status).toBe("running"); // not yet reconciled
		expect(t.runState).toBe("completed"); // the live job is done
		expect(t.lastVerification).toBe("passed");
		expect(t.lastVerificationSource).toBe("chit");
	});

	test("a running task surfaces the joined loop job's participant provenance", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		const jobId = firstJob();
		const j = present(jobs.jobs.get(jobId), "launched job");
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
		jobs.jobs.set(jobId, { ...j, state: "running", participants });
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const t = present(
			view.tasks.find((x) => x.id === "a"),
			"task a view",
		);
		expect(t.participants).toEqual(participants);
		// Only env key names surface; no env values.
		expect(JSON.stringify(t.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});

	test("a terminal (reconciled) task row keeps the provenance after the live job join is gone", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
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
		// The job converged carrying its provenance; reconcile snapshots it into the durable result.
		jobs.finish(firstJob(), { stopStatus: "converged", lastVerdict: "proceed", participants });
		const c = advanceBatch(store, deps, "c1");
		expect(taskOf(c, "a").status).toBe("review_ready");
		// Re-describe AFTER reconcile: the task is no longer running, so the live job join does not
		// run -- provenance must come from the snapshotted result.
		const view = describeBatch(present(store.get("c1"), "batch c1"), deps);
		const t = present(
			view.tasks.find((x) => x.id === "a"),
			"task a view",
		);
		expect(t.status).toBe("review_ready");
		expect(t.participants).toEqual(participants);
		expect(JSON.stringify(t.participants)).not.toContain("ANTHROPIC_API_KEY=");
	});
});

describe("cancelBatch", () => {
	test("cancels active jobs and marks the batch cancelled", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		const runningJobId = firstJob();
		const c = cancelBatch(store, deps, "c1");
		expect(c.status).toBe("cancelled");
		expect(jobs.cancelled).toContain(runningJobId);
		expect(c.tasks.find((t) => t.id === "a")?.status).toBe("cancelled");
		expect(c.tasks.find((t) => t.id === "b")?.status).toBe("cancelled"); // pending -> cancelled
	});
});

describe("cleanupBatch", () => {
	// Drive a batch to ready_for_review (both tasks converged) for cleanup.
	function readyBatch(): void {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		for (const l of jobs.launched) jobs.finish(l.jobId, { stopStatus: "converged" });
		advanceBatch(store, deps, "c1");
	}

	test("dry run (default) reports the plan and removes NOTHING", () => {
		readyBatch();
		const r = cleanupBatch(store, deps, "c1", { confirm: false });
		expect(r.confirmed).toBe(false);
		expect(r.removable.map((e) => e.id).sort()).toEqual(["a", "b"]);
		expect(r.removable[0]?.changedFiles).toEqual(["f.ts"]); // diff that would be discarded
		expect(r.receiptsKept).toBe(true);
		expect(removedWorktrees).toHaveLength(0); // nothing removed on a dry run
		expect(store.get("c1")?.cleanedAt).toBeUndefined();
	});

	test("confirm removes worktrees + branches (from the main repo) and records cleanedAt", () => {
		readyBatch();
		const r = cleanupBatch(store, deps, "c1", { confirm: true });
		expect(r.confirmed).toBe(true);
		expect(r.removable.every((e) => e.removed)).toBe(true);
		expect(removedWorktrees).toHaveLength(2);
		// removal runs against the main repo, never the worktree being removed
		expect(removedWorktrees.every((w) => w.repo === store.get("c1")?.repo)).toBe(true);
		expect(store.get("c1")?.cleanedAt).toBeDefined();
	});

	test("refuses while a task is still running", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		// a's job is queued/running (not converged) -> task still running
		expect(() => cleanupBatch(store, deps, "c1", { confirm: true })).toThrow(/live worker/);
		expect(removedWorktrees).toHaveLength(0);
	});

	test("skips tasks that never launched (no worktree)", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1"); // a review_ready, b now running
		jobs.finish(present(jobs.launched[1], "second launched job").jobId, {
			stopStatus: "converged",
		});
		advanceBatch(store, deps, "c1"); // b review_ready -> ready_for_review
		const r = cleanupBatch(store, deps, "c1", { confirm: false });
		// both launched, so both removable; none skipped
		expect(r.removable.map((e) => e.id).sort()).toEqual(["a", "b"]);
		expect(r.skipped).toHaveLength(0);
	});
});

describe("listBatches", () => {
	test("summarizeBatch counts review_ready and failed tasks", () => {
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b")],
			maxParallel: 2,
		});
		// a converges (review_ready); b goes stale (failed)
		jobs.finish(firstJob(), { stopStatus: "converged" });
		const bJobId = present(jobs.launched[1], "second job").jobId;
		deps.isStale = (job) => job.runId === bJobId;
		advanceBatch(store, deps, "c1");
		const s = summarizeBatch(present(store.get("c1"), "batch c1"));
		expect(s).toMatchObject({
			batch_id: "c1",
			taskCount: 2,
			reviewReady: 1,
			failed: 1,
		});
		expect(s.cleanedAt).toBeUndefined();
	});

	test("lists every batch in the repo, newest-created first", () => {
		deps.now = () => 1000;
		startBatch(store, deps, { id: "old", cwd, tasks: [task("a")], maxParallel: 1 });
		deps.now = () => 2000;
		startBatch(store, deps, { id: "new", cwd, tasks: [task("a")], maxParallel: 1 });
		const ids = listBatches(store).map((b) => b.batch_id);
		expect(ids).toEqual(["new", "old"]);
	});

	test("respects the limit (newest first)", () => {
		deps.now = () => 1000;
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		deps.now = () => 2000;
		startBatch(store, deps, { id: "c2", cwd, tasks: [task("a")], maxParallel: 1 });
		deps.now = () => 3000;
		startBatch(store, deps, { id: "c3", cwd, tasks: [task("a")], maxParallel: 1 });
		expect(listBatches(store, 2).map((b) => b.batch_id)).toEqual(["c3", "c2"]);
	});

	test("surfaces cleanedAt once a batch has been cleaned up", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1"); // -> ready_for_review
		cleanupBatch(store, deps, "c1", { confirm: true });
		const s = summarizeBatch(present(store.get("c1"), "batch c1"));
		expect(s.cleanedAt).toBeDefined();
	});

	test("returns an empty list for a repo with no batches", () => {
		expect(listBatches(store)).toEqual([]);
	});
});

describe("batchWaitState (what chit_wait blocks on for a batch)", () => {
	test("tasks in flight, nothing reconcilable -> working (keep waiting)", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		// Both jobs queued/running, none stale, none finished: advance would do nothing.
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("working");
	});

	test("a finished job that can be reconciled -> needs_advance", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		jobs.finish(firstJob(), { stopStatus: "converged", lastVerdict: "proceed" });
		// A converged job is settleable, so the next advance would reconcile it.
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("needs_advance");
	});

	test("a pending task that becomes runnable -> needs_advance", () => {
		// b depends on a; cap 1 so b is pending. When a converges, b becomes runnable.
		startBatch(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 1,
		});
		jobs.finish(firstJob(), { stopStatus: "converged", lastVerdict: "proceed" });
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("needs_advance");
	});

	test("a fully settled batch -> terminal", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged", lastVerdict: "proceed" });
		advanceBatch(store, deps, "c1"); // -> ready_for_review
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("terminal");
	});

	test("a stale worker is reconcilable -> needs_advance (so a wait never hangs on a dead worker)", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		const jobId = firstJob();
		deps.isStale = (job) => job.runId === jobId;
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("needs_advance");
	});

	test("a VANISHED job record is reconcilable -> needs_advance (advanceBatch would fail it, not hang)", () => {
		// Regression: reconcile() settles a running task whose job record is gone to
		// failed, so the wait must surface that as actionable, not "working".
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.jobs.clear(); // the job record disappeared (cleanup, corruption, ...)
		expect(batchWaitState(present(store.get("c1"), "c1"), deps)).toBe("needs_advance");
		// And advanceBatch genuinely acts on it (proves the predicate matches reality).
		const c = advanceBatch(store, deps, "c1");
		expect(taskOf(c, "a").status).toBe("failed");
	});
});

// The MCP response-shape contract. The batch tools are pass-throughs:
// chit_batch_start / chit_batch_status return describeBatch(...), chit_batch_list
// returns listBatches(...) rows (summarizeBatch), chit_batch_cleanup returns
// cleanupBatch(...). So pinning these payloads pins the boundary clients actually
// read. The boundary id is `batch_id` (matching every batch tool's INPUT param and
// the run_id / audit_ref convention); a top-level `id` or camelCase `batchId` must
// never reappear. Task-level `id` and `run_id` stay (they are not the batch handle).
describe("MCP response-shape contract: batch payloads use batch_id, not id/batchId", () => {
	// Drive a single task to ready_for_review so every view has real content (a
	// removable worktree for cleanup, a terminal status for the summary).
	function readyBatch(): Batch {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1"); // a -> review_ready, batch -> ready_for_review
		return present(store.get("c1"), "batch c1");
	}

	test("describeBatch (chit_batch_start / chit_batch_status) has top-level batch_id, not id/batchId", () => {
		const v = describeBatch(readyBatch(), deps);
		expect(v.batch_id).toBe("c1");
		expect("id" in v).toBe(false);
		expect("batchId" in v).toBe(false);
		// Task-level ids are preserved: a task keeps `id`, and a launched task its run_id.
		const t = present(v.tasks[0], "task view");
		expect(t.id).toBe("a");
		expect(t.run_id).toBeDefined();
	});

	test("listBatches rows (chit_batch_list) have batch_id, not id", () => {
		readyBatch();
		const row = present(listBatches(store)[0], "list row");
		expect(row.batch_id).toBe("c1");
		expect("id" in row).toBe(false);
	});

	test("cleanupBatch (chit_batch_cleanup) has batch_id, not batchId/id, on both dry-run and confirm", () => {
		readyBatch();
		const dry = cleanupBatch(store, deps, "c1", { confirm: false });
		expect(dry.batch_id).toBe("c1");
		expect("batchId" in dry).toBe(false);
		expect("id" in dry).toBe(false);
		const done = cleanupBatch(store, deps, "c1", { confirm: true });
		expect(done.batch_id).toBe("c1");
		expect("batchId" in done).toBe(false);
		expect("id" in done).toBe(false);
		// The per-task removable entries still carry their own task `id`.
		expect(present(done.removable[0], "removable entry").id).toBe("a");
	});
});

// A cold agent follows nextAction literally (a real dogfood quoted the documented
// wait->advance loop verbatim). A terminal batch that only said "review the task
// worktrees" left one agent to guess, and it wrongly told the user to pass the
// batch_id to chit_audit_show (receipts open by audit_ref). So every terminal state
// must name the next tool calls: receipts via chit_audit_show { audit_ref } and
// retirement via chit_batch_cleanup, and flag that the work is uncommitted.
describe("batch terminal nextAction guides to receipts + cleanup (not the batch_id)", () => {
	test("ready_for_review names chit_audit_show { audit_ref }, uncommitted changes, and chit_batch_cleanup", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("ready_for_review");
		expect(v.nextAction).toContain("chit_audit_show");
		expect(v.nextAction).toContain("audit_ref");
		expect(v.nextAction).toContain("chit_batch_cleanup");
		expect(v.nextAction.toLowerCase()).toContain("uncommitted");
		// The bug guard: it must NOT steer the agent to use the batch_id for receipts.
		expect(v.nextAction).not.toContain("batch_id");
	});

	test("cancelled also points at receipts + cleanup, not a bare 'batch cancelled'", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		cancelBatch(store, deps, "c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("cancelled");
		expect(v.nextAction).toContain("chit_audit_show");
		expect(v.nextAction).toContain("chit_batch_cleanup");
	});
});

// Once chit_batch_cleanup has retired a terminal batch's worktrees + branches (cleanedAt set),
// nextAction must stop telling the operator to run cleanup again or to inspect worktrees that no
// longer exist. It still routes to the surviving receipts. This is the batch parity of the 0.36.1
// plan fix. Tests stamp cleanedAt directly (mirroring the plan engine tests) to isolate describeBatch.
describe("terminal nextAction after cleanup (cleanedAt) drops stale cleanup/worktree guidance", () => {
	function stampCleaned(id: string): void {
		store.update(id, (c) => {
			c.cleanedAt = "2026-06-06T00:00:00.000Z";
			return c;
		});
	}

	test("ready_for_review WITHOUT cleanedAt still mentions chit_batch_cleanup", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("ready_for_review");
		expect(v.cleanedAt).toBeUndefined();
		expect(v.nextAction).toContain("chit_batch_cleanup");
	});

	test("ready_for_review WITH cleanedAt drops chit_batch_cleanup and reports the retired state + receipts", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "converged" });
		advanceBatch(store, deps, "c1");
		stampCleaned("c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("ready_for_review");
		expect(v.cleanedAt).toBe("2026-06-06T00:00:00.000Z");
		expect(v.nextAction).not.toContain("chit_batch_cleanup");
		// still reports the useful terminal state: all tasks terminal, worktrees already retired...
		expect(v.nextAction).toContain("all tasks terminal");
		expect(v.nextAction).toContain("already retired");
		expect(v.nextAction).toContain("2026-06-06T00:00:00.000Z");
		// ...and keeps the receipts pointer (receipts survive cleanup, open by audit_ref).
		expect(v.nextAction).toContain("receipts remain available");
		expect(v.nextAction).toContain("chit_audit_show");
	});

	test("cancelled WITH cleanedAt drops chit_batch_cleanup and keeps receipts guidance", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		cancelBatch(store, deps, "c1");
		stampCleaned("c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("cancelled");
		expect(v.nextAction).not.toContain("chit_batch_cleanup");
		expect(v.nextAction).toContain("already retired");
		expect(v.nextAction).toContain("chit_audit_show");
		// a cleaned cancelled batch no longer has worktrees "kept for inspection"
		expect(v.nextAction).not.toContain("kept for inspection");
	});

	test("failed WITH cleanedAt drops chit_batch_cleanup and does not tell the operator to inspect retired worktrees", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { state: "failed", failure: "boom" });
		advanceBatch(store, deps, "c1");
		stampCleaned("c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("failed");
		expect(v.nextAction).not.toContain("chit_batch_cleanup");
		// no "inspect ... worktree" pointer (the worktrees are gone); receipts guidance stays.
		expect(v.nextAction).not.toMatch(/inspect[^.]*worktree/i);
		expect(v.nextAction).toContain("already retired");
		expect(v.nextAction).toContain("chit_audit_show");
	});

	test("needs_human WITH cleanedAt drops chit_batch_cleanup and does not tell the operator to inspect retired worktrees", () => {
		startBatch(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		jobs.finish(firstJob(), { stopStatus: "needs-decision" });
		advanceBatch(store, deps, "c1"); // a -> needs_attention, batch -> needs_human
		stampCleaned("c1");
		const v = describeBatch(present(store.get("c1"), "batch c1"), deps);
		expect(v.status).toBe("needs_human");
		expect(v.nextAction).toContain("need attention");
		expect(v.nextAction).not.toContain("chit_batch_cleanup");
		expect(v.nextAction).not.toMatch(/inspect[^.]*worktree/i);
		expect(v.nextAction).toContain("already retired");
		expect(v.nextAction).toContain("receipt");
	});
});
