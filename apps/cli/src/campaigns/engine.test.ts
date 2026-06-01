import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "../jobs/types.ts";
import {
	advanceCampaign,
	type CampaignEngineDeps,
	cancelCampaign,
	describeCampaign,
	startCampaign,
} from "./engine.ts";
import type { TaskInput } from "./plan.ts";
import { CampaignStore } from "./store.ts";
import type { Campaign, CampaignTask } from "./types.ts";
import type { GitRunner } from "./worktree.ts";

// A fake job world: launchJob registers a running job; tests then flip a job's
// state to simulate the background worker finishing.
class FakeJobs {
	jobs = new Map<string, JobRecord>();
	launched: Array<{ jobId: string; cwd: string; manifestPath?: string; scope: string }> = [];
	cancelled: string[] = [];
	private seq = 0;

	launch = (p: {
		cwd: string;
		scope: string;
		task: string;
		loopId: string;
		manifestPath?: string;
		maxIterations: number;
	}): { jobId: string; loopId: string } => {
		const jobId = `job-${++this.seq}`;
		// Real launchConvergeJob creates jobs as "queued"; the worker flips them to
		// "running". Mirror that here so the reconcile path is tested against reality
		// (a just-launched queued job must NOT be reconciled as failed).
		this.jobs.set(jobId, {
			jobId,
			loopId: p.loopId,
			repoKey: "k",
			cwd: p.cwd,
			scope: p.scope,
			task: p.task,
			maxIterations: p.maxIterations,
			allowUnenforced: false,
			state: "queued",
			createdAt: "t",
			iterationsCompleted: 0,
			auditRefs: [],
		});
		this.launched.push({ jobId, cwd: p.cwd, manifestPath: p.manifestPath, scope: p.scope });
		return { jobId, loopId: p.loopId };
	};
	get = (jobId: string): JobRecord | undefined => this.jobs.get(jobId);
	cancel = (jobId: string): void => {
		this.cancelled.push(jobId);
	};
	// Test helper: settle a job to a terminal state.
	finish(jobId: string, over: Partial<JobRecord>): void {
		const j = this.jobs.get(jobId);
		if (j) this.jobs.set(jobId, { ...j, state: "completed", iterationsCompleted: 1, ...over });
	}
}

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: CampaignStore;
let jobs: FakeJobs;
let deps: CampaignEngineDeps;
let wtSeq = 0;

const fakeGit: GitRunner = (args) => {
	if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
		return { code: 0, stdout: `${cwd}\n`, stderr: "" };
	}
	if (args[0] === "rev-parse") return { code: 0, stdout: "basesha\n", stderr: "" };
	return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-eng-cwd-"));
	stateDir = mkdtempSync(join(tmpdir(), "chit-eng-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new CampaignStore(cwd);
	jobs = new FakeJobs();
	wtSeq = 0;
	deps = {
		git: fakeGit,
		createWorktree: (_repo, cid, tid) => ({
			worktreePath: `/wt/${cid}/${tid}-${++wtSeq}`,
			branch: `chit-campaign/${cid}/${tid}`,
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

function task(id: string, over: Partial<TaskInput> = {}): TaskInput {
	return { id, title: id, body: `do ${id}`, claimedPaths: [`${id}/**`], ...over };
}

// Guard helper: assert-present without a non-null assertion (keeps the lint clean).
function present<T>(v: T | undefined, what: string): T {
	if (v === undefined) throw new Error(`expected ${what} to be present`);
	return v;
}
const firstJob = () => present(jobs.launched[0], "first launched job").jobId;
const taskOf = (c: Campaign, id: string): CampaignTask =>
	present(
		c.tasks.find((t) => t.id === id),
		`task ${id}`,
	);

describe("startCampaign", () => {
	test("launches the initial wave of independent tasks up to the cap", () => {
		const c = startCampaign(store, deps, {
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

	test("resolves the per-task manifest override (task > campaign > default)", () => {
		startCampaign(store, deps, {
			id: "c1",
			cwd,
			manifestPath: "/camp.json",
			tasks: [task("a", { manifestPath: "/task.json" }), task("b")],
			maxParallel: 2,
		});
		const byScope = Object.fromEntries(jobs.launched.map((l) => [l.scope, l.manifestPath]));
		expect(byScope["campaign-c1-a"]).toBe("/task.json"); // task override
		expect(byScope["campaign-c1-b"]).toBe("/camp.json"); // campaign default
	});

	test("a dependent task does not launch until its dependency is review_ready", () => {
		const c = startCampaign(store, deps, {
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

describe("advanceCampaign", () => {
	test("reconciles a converged job to review_ready and launches the dependent", () => {
		startCampaign(store, deps, {
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
		const c = advanceCampaign(store, deps, "c1");
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

	test("a blocked/max-iterations job fails the task and does NOT proceed dependents", () => {
		startCampaign(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		jobs.finish(firstJob(), { stopStatus: "max-iterations" });
		const c = advanceCampaign(store, deps, "c1");
		expect(c.tasks.find((t) => t.id === "a")?.status).toBe("failed");
		expect(c.tasks.find((t) => t.id === "b")?.status).toBe("pending"); // not launched
		expect(c.status).toBe("needs_human"); // b is blocked by a's failure
	});

	test("advance immediately after start does NOT fail a just-launched queued job", () => {
		// Regression: a freshly launched job is "queued" (worker not yet running).
		// Reconcile must treat queued as in-flight, not terminal, or a valid campaign
		// self-fails on the first advance.
		startCampaign(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		const c = advanceCampaign(store, deps, "c1"); // jobs still queued
		expect(c.tasks.every((t) => t.status === "running")).toBe(true);
		expect(c.status).toBe("running");
	});

	test("campaign loop ids are globally unique (campaign-namespaced, not bare task id)", () => {
		startCampaign(store, deps, { id: "camp-uuid", cwd, tasks: [task("docs")], maxParallel: 1 });
		const job = jobs.get(firstJob());
		expect(job?.loopId).toBe("camp-uuid-docs"); // not just "docs"
	});

	test("a stale running job is settled failed", () => {
		startCampaign(store, deps, { id: "c1", cwd, tasks: [task("a")], maxParallel: 1 });
		deps.isStale = () => true; // worker went dark
		const c = advanceCampaign(store, deps, "c1");
		expect(c.tasks[0]?.status).toBe("failed");
		expect(c.tasks[0]?.error).toMatch(/stale/);
	});

	test("all converged -> ready_for_review", () => {
		startCampaign(store, deps, { id: "c1", cwd, tasks: [task("a"), task("b")], maxParallel: 2 });
		for (const l of jobs.launched) jobs.finish(l.jobId, { stopStatus: "converged" });
		const c = advanceCampaign(store, deps, "c1");
		expect(c.status).toBe("ready_for_review");
		expect(c.tasks.every((t) => t.status === "review_ready")).toBe(true);
	});
});

describe("describeCampaign is read-only", () => {
	test("does not launch or mutate; reports nextAction", () => {
		startCampaign(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		const launchedBefore = jobs.launched.length;
		jobs.finish(firstJob(), { stopStatus: "converged" });
		const view = describeCampaign(present(store.get("c1"), "campaign c1"), deps);
		// describe launched nothing even though a is now reconcilable + b runnable
		expect(jobs.launched.length).toBe(launchedBefore);
		expect(view.nextAction).toMatch(/chit_campaign_advance/);
		// a's task status on disk is still "running" (describe did not reconcile)
		expect(store.get("c1")?.tasks.find((t) => t.id === "a")?.status).toBe("running");
	});
});

describe("cancelCampaign", () => {
	test("cancels active jobs and marks the campaign cancelled", () => {
		startCampaign(store, deps, {
			id: "c1",
			cwd,
			tasks: [task("a"), task("b", { dependencies: ["a"] })],
			maxParallel: 2,
		});
		const runningJobId = firstJob();
		const c = cancelCampaign(store, deps, "c1");
		expect(c.status).toBe("cancelled");
		expect(jobs.cancelled).toContain(runningJobId);
		expect(c.tasks.find((t) => t.id === "a")?.status).toBe("cancelled");
		expect(c.tasks.find((t) => t.id === "b")?.status).toBe("cancelled"); // pending -> cancelled
	});
});
