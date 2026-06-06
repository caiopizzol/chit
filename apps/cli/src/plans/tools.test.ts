import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanError } from "@chit-run/core";
import type { GitResult, GitRunner } from "../batches/worktree.ts";
import type { LoopJobRecord } from "../jobs/types.ts";
import type { LaunchPlanJobParams, PlanEngineDeps } from "./engine.ts";
import { PlanStore } from "./store.ts";
import { loadPlanInput, runPlanStart } from "./tools.ts";

let dir: string;
let stateDir: string;
let savedXdg: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-plan-tools-"));
	// PlanStore writes under XDG_STATE_HOME; isolate it so runPlanStart persists into a temp dir.
	stateDir = mkdtempSync(join(tmpdir(), "chit-plan-tools-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(dir, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function present<T>(v: T | undefined, what: string): T {
	if (v === undefined) throw new Error(`expected ${what} to be present`);
	return v;
}

const PLAN = {
	schema: 1,
	title: "demo",
	steps: [
		{ id: "a", title: "A", body: "do a" },
		{ id: "b", title: "B", body: "do b", dependsOn: ["a"] },
	],
};

describe("loadPlanInput", () => {
	test("normalizes an inline plan object", () => {
		const plan = loadPlanInput({ plan: PLAN }, dir);
		expect(plan.title).toBe("demo");
		expect(plan.steps.map((s) => s.id)).toEqual(["a", "b"]);
		// dependsOn is normalized to [] for a step that declares none.
		expect(plan.steps[0]?.dependsOn).toEqual([]);
		expect(plan.cleanup).toBe("after_apply");
	});

	test("normalizes an inline plan passed as a JSON string", () => {
		const plan = loadPlanInput({ plan: JSON.stringify(PLAN) }, dir);
		expect(plan.title).toBe("demo");
		expect(plan.steps).toHaveLength(2);
	});

	test("reads and normalizes a plan from plan_path (relative to cwd)", () => {
		writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
		const plan = loadPlanInput({ planPath: "plan.json" }, dir);
		expect(plan.title).toBe("demo");
		expect(plan.steps[1]?.dependsOn).toEqual(["a"]);
	});

	test("rejects providing both plan and plan_path", () => {
		writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
		expect(() => loadPlanInput({ plan: PLAN, planPath: "plan.json" }, dir)).toThrow(PlanError);
	});

	test("rejects providing neither", () => {
		expect(() => loadPlanInput({}, dir)).toThrow(/exactly one/);
	});

	test("reports a missing plan_path as a PlanError, not a raw fs error", () => {
		expect(() => loadPlanInput({ planPath: "nope.json" }, dir)).toThrow(PlanError);
	});

	test("reports invalid JSON as a PlanError", () => {
		writeFileSync(join(dir, "bad.json"), "{ not json");
		expect(() => loadPlanInput({ planPath: "bad.json" }, dir)).toThrow(/invalid JSON/);
	});

	test("surfaces a structural validation failure (a dependency cycle) from parsePlan", () => {
		const cyclic = {
			schema: 1,
			title: "c",
			steps: [
				{ id: "a", title: "A", body: "x", dependsOn: ["b"] },
				{ id: "b", title: "B", body: "y", dependsOn: ["a"] },
			],
		};
		expect(() => loadPlanInput({ plan: cyclic }, dir)).toThrow(/cycle/);
	});
});

// --- runPlanStart: the chit_plan_start handler glue, with deps injected so it never
// resolves a real repo or spawns the detached workers the real deps launch. -----------

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

// A plain main-repo checkout: --git-common-dir is <cwd>/.git, so mainRepoOfWorktree
// resolves repo back to cwd (repo === callerCheckout for a non-linked launch).
function makeHarness() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-plan-start-cwd-")));
	const jobs = new Map<string, LoopJobRecord>();
	const launched: LaunchPlanJobParams[] = [];
	let seq = 0;
	const git: GitRunner = (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${cwd}\n`);
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${cwd}/.git\n`);
		if (args[0] === "rev-parse") return ok("basesha\n");
		return ok("");
	};
	const deps: PlanEngineDeps = {
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
			launched.push(p);
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => jobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
		now: () => 1000,
	};
	return { cwd, deps, store: new PlanStore(cwd), jobs, launched };
}

const START_PLAN = {
	schema: 1,
	title: "start demo",
	steps: [
		{ id: "a", title: "A", body: "do a" },
		{ id: "b", title: "B", body: "do b", dependsOn: ["a"] },
	],
};

describe("runPlanStart", () => {
	test("starts from an inline plan: returns the view, launches only the first step, persists", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const view = runPlanStart({ plan: START_PLAN }, cwd, store, deps, () => "gen-id");
		// The view leads with plan_id and carries the step join.
		expect(view.plan_id).toBe("gen-id");
		expect(view.title).toBe("start demo");
		const a = present(
			view.steps.find((s) => s.id === "a"),
			"step a",
		);
		const b = present(
			view.steps.find((s) => s.id === "b"),
			"step b",
		);
		expect(a.status).toBe("running");
		expect(a.run_id).toBeDefined();
		expect(b.status).toBe("pending"); // the dependent waits
		// Persisted under the durable store so chit_plan_list/status recover it later.
		expect(present(store.get("gen-id"), "stored plan").id).toBe("gen-id");
		// Exactly one step launched, carrying its worktree metadata for chit_apply.
		expect(launched).toHaveLength(1);
		expect(present(launched[0], "launched a").worktree.repo).toBe(cwd);
	});

	test("starts from a plan_path file (read relative to cwd)", () => {
		const { cwd, deps, store } = makeHarness();
		writeFileSync(join(cwd, "plan.json"), JSON.stringify(START_PLAN));
		const view = runPlanStart({ planPath: "plan.json" }, cwd, store, deps, () => "gen-id");
		expect(view.plan_id).toBe("gen-id");
		expect(view.steps.map((s) => s.id)).toEqual(["a", "b"]);
		expect(present(store.get("gen-id"), "stored plan").steps).toHaveLength(2);
	});

	test("uses the plan's own id when authored, else the generated id", () => {
		const { cwd, deps, store } = makeHarness();
		const view = runPlanStart({ plan: { ...START_PLAN, id: "my-plan" } }, cwd, store, deps, () => {
			throw new Error("genId must not be called when the plan declares an id");
		});
		expect(view.plan_id).toBe("my-plan");
		expect(store.get("my-plan")).toBeDefined();
	});

	test("forwards base_branch and max_iterations to the engine", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const view = runPlanStart(
			{ plan: START_PLAN, baseBranch: "develop", maxIterations: 7 },
			cwd,
			store,
			deps,
			() => "p",
		);
		expect(view.baseBranch).toBe("develop");
		// The step declares no maxIterations, so the plan default flows onto the launched job.
		expect(present(launched[0], "launched a").maxIterations).toBe(7);
	});
});
