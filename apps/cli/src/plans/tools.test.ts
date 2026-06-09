import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanError } from "@chit-run/core";
import type { GitResult, GitRunner } from "../batches/worktree.ts";
import type { LoopJobRecord } from "../jobs/types.ts";
import type { LaunchPlanJobParams, PlanEngineDeps } from "./engine.ts";
import { PlanStore } from "./store.ts";
import { loadPlanInput, PlanApprovalRefused, runPlanStart } from "./tools.ts";

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
// resolves repo back to cwd (repo === callerCheckout for a non-linked launch). A symbolic
// ref (HEAD / develop) resolves to the harness's current head sha (mutable, so a test can
// simulate the ref moving after approval); a concrete sha resolves to itself, so pinning a
// launch to base.sha lands on that exact commit.
function makeHarness() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chit-plan-start-cwd-")));
	const jobs = new Map<string, LoopJobRecord>();
	const launched: LaunchPlanJobParams[] = [];
	let seq = 0;
	let headSha = "sha-approved";
	const setHeadSha = (sha: string) => {
		headSha = sha;
	};
	const git: GitRunner = (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${cwd}\n`);
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${cwd}/.git\n`);
		if (args[0] === "rev-parse") {
			const ref = args[1] ?? "HEAD";
			// Symbolic refs follow the moving head; a concrete sha resolves to itself.
			if (ref === "HEAD" || ref === "develop") return ok(`${headSha}\n`);
			return ok(`${ref}\n`);
		}
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
		// runPlanStart never applies/commits/cleans; throw if a start test reaches these.
		applyWorkspace: () => {
			throw new Error("applyWorkspace is not wired in the start harness");
		},
		commit: () => {
			throw new Error("commit is not wired in the start harness");
		},
		removeWorktree: () => {
			throw new Error("removeWorktree is not wired in the start harness");
		},
		removeEmptyDir: () => {
			throw new Error("removeEmptyDir is not wired in the start harness");
		},
		now: () => 1000,
	};
	return { cwd, deps, store: new PlanStore(cwd), jobs, launched, setHeadSha };
}

const START_PLAN = {
	schema: 1,
	title: "start demo",
	steps: [
		{ id: "a", title: "A", body: "do a" },
		{ id: "b", title: "B", body: "do b", dependsOn: ["a"] },
	],
};

// The genId that a dry run must never reach (a dry run creates no plan, so no id is drawn).
const noLaunch = () => {
	throw new Error("genId must not be called on a dry run");
};

describe("runPlanStart: dry run (the default, no confirm)", () => {
	test("returns the normalized plan, resolved base, and an approval hash; launches nothing", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const result = runPlanStart({ plan: START_PLAN }, cwd, store, deps, noLaunch);
		expect(result.launched).toBe(false);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.strategy).toBe("plan");
		expect(result.plan.title).toBe("start demo");
		expect(result.plan.steps.map((s) => s.id)).toEqual(["a", "b"]);
		// The base ref defaults to HEAD and resolves to the harness head sha.
		expect(result.base).toEqual({ ref: "HEAD", sha: "sha-approved" });
		expect(result.approvalHash).toMatch(/^[0-9a-f]{64}$/);
		// No plan record, no job, no worktree.
		expect(store.get("gen-id")).toBeUndefined();
		expect(launched).toHaveLength(0);
	});

	test("resolves an explicit base_branch ref to its commit for the approval", () => {
		const { cwd, deps, store } = makeHarness();
		const result = runPlanStart(
			{ plan: START_PLAN, baseBranch: "develop" },
			cwd,
			store,
			deps,
			noLaunch,
		);
		if (result.launched) throw new Error("expected a dry run");
		expect(result.base).toEqual({ ref: "develop", sha: "sha-approved" });
	});
});

// Re-run the dry run THEN confirm with the hash it returned, mirroring the operator flow.
function approveAndConfirm(
	h: ReturnType<typeof makeHarness>,
	input: Parameters<typeof runPlanStart>[0],
	genId: () => string,
) {
	const dry = runPlanStart(input, h.cwd, h.store, h.deps, noLaunch);
	if (dry.launched) throw new Error("expected a dry run");
	return runPlanStart(
		{ ...input, confirm: true, approvalHash: dry.approvalHash },
		h.cwd,
		h.store,
		h.deps,
		genId,
	);
}

describe("runPlanStart: confirmed launch (hash-gated)", () => {
	test("a matching approval_hash launches the first step and persists, pinned to the base sha", () => {
		const h = makeHarness();
		const result = approveAndConfirm(h, { plan: START_PLAN }, () => "gen-id");
		expect(result.launched).toBe(true);
		if (!result.launched) throw new Error("expected a launch");
		expect(result.view.plan_id).toBe("gen-id");
		const a = present(
			result.view.steps.find((s) => s.id === "a"),
			"step a",
		);
		const b = present(
			result.view.steps.find((s) => s.id === "b"),
			"step b",
		);
		expect(a.status).toBe("running");
		expect(b.status).toBe("pending"); // the dependent waits
		// The launch is pinned to the approved COMMIT, not the ref: baseBranch is recorded as the
		// sha, never "HEAD", so a later ref move cannot redirect the run.
		expect(result.view.baseBranch).toBe("sha-approved");
		expect(result.base).toEqual({ ref: "HEAD", sha: "sha-approved" });
		// Persisted and launched exactly once, carrying its worktree metadata for chit_apply.
		expect(present(h.store.get("gen-id"), "stored plan").id).toBe("gen-id");
		expect(h.launched).toHaveLength(1);
		expect(present(h.launched[0], "launched a").worktree.repo).toBe(h.cwd);
		expect(present(h.launched[0], "launched a").worktree.baseSha).toBe("sha-approved");
	});

	test("uses the plan's own id when authored, else the generated id", () => {
		const h = makeHarness();
		const result = approveAndConfirm(h, { plan: { ...START_PLAN, id: "my-plan" } }, () => {
			throw new Error("genId must not be called when the plan declares an id");
		});
		if (!result.launched) throw new Error("expected a launch");
		expect(result.view.plan_id).toBe("my-plan");
		expect(h.store.get("my-plan")).toBeDefined();
	});

	test("forwards max_iterations (bound into the hash) onto the launched job", () => {
		const h = makeHarness();
		const result = approveAndConfirm(
			h,
			{ plan: START_PLAN, baseBranch: "develop", maxIterations: 7 },
			() => "p",
		);
		if (!result.launched) throw new Error("expected a launch");
		// The step declares no maxIterations, so the plan default flows onto the launched job.
		expect(present(h.launched[0], "launched a").maxIterations).toBe(7);
	});
});

describe("runPlanStart: the gate refuses before any mutation", () => {
	test("confirm with no approval_hash is refused", () => {
		const { cwd, deps, store, launched } = makeHarness();
		expect(() =>
			runPlanStart({ plan: START_PLAN, confirm: true }, cwd, store, deps, noLaunch),
		).toThrow(PlanApprovalRefused);
		expect(store.get("gen-id")).toBeUndefined();
		expect(launched).toHaveLength(0);
	});

	test("confirm with a wrong approval_hash is refused", () => {
		const { cwd, deps, store, launched } = makeHarness();
		expect(() =>
			runPlanStart(
				{ plan: START_PLAN, confirm: true, approvalHash: "deadbeef" },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(PlanApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a plan edited after the dry run is refused with the old hash", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runPlanStart({ plan: START_PLAN }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		const edited = {
			...START_PLAN,
			steps: [START_PLAN.steps[0], { ...START_PLAN.steps[1], body: "do b DIFFERENTLY" }],
		};
		expect(() =>
			runPlanStart(
				{ plan: edited, confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(PlanApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a changed base ref is refused with the old hash", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runPlanStart({ plan: START_PLAN }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		// Approved against HEAD; confirming against a different ref (develop) recomputes a different
		// hash even though both resolve to the same sha here, because the ref is part of the artifact.
		expect(() =>
			runPlanStart(
				{ plan: START_PLAN, baseBranch: "develop", confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(PlanApprovalRefused);
		expect(launched).toHaveLength(0);
	});

	test("a moved base sha (same ref) is refused with the old hash", () => {
		const h = makeHarness();
		const dry = runPlanStart({ plan: START_PLAN }, h.cwd, h.store, h.deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		// The ref (HEAD) is unchanged, but its commit moved after approval.
		h.setHeadSha("sha-moved");
		expect(() =>
			runPlanStart(
				{ plan: START_PLAN, confirm: true, approvalHash: dry.approvalHash },
				h.cwd,
				h.store,
				h.deps,
				noLaunch,
			),
		).toThrow(PlanApprovalRefused);
		expect(h.launched).toHaveLength(0);
	});

	test("a changed max_iterations is refused with the old hash (the budget is bound)", () => {
		const { cwd, deps, store, launched } = makeHarness();
		const dry = runPlanStart({ plan: START_PLAN, maxIterations: 3 }, cwd, store, deps, noLaunch);
		if (dry.launched) throw new Error("expected a dry run");
		expect(() =>
			runPlanStart(
				{ plan: START_PLAN, maxIterations: 9, confirm: true, approvalHash: dry.approvalHash },
				cwd,
				store,
				deps,
				noLaunch,
			),
		).toThrow(PlanApprovalRefused);
		expect(launched).toHaveLength(0);
	});
});
