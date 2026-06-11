import { describe, expect, test } from "bun:test";
import { type NormalizedPlan, parsePlan } from "@chit-run/core";
import type { PlanStartResult } from "../../plans/tools.ts";
import {
	type OrchestrateDeps,
	OrchestrateError,
	PLAN_AUTHOR_MANIFEST_PATH,
	type PlannerRunArgs,
	runOrchestrate,
} from "./orchestrate.ts";

// runOrchestrate composes the planning primitives with NO real planner run and NO real
// dry run: the planner runner and the dry-run path are injected, so these unit tests pin
// the composition (run planner -> parse JSON -> validate -> dry-run -> assert not launched
// -> shape the result) without spawning an agent, reading a manifest, or touching git.

// A small but parsePlan-valid plan the fake planner emits, and the dry run resolves.
const PLAN = {
	schema: 1,
	title: "Add a thing",
	steps: [
		{
			id: "step-one",
			title: "First step",
			body: "Do the first part of the work.",
			dependsOn: [],
			commitMessage: "feat: add the first part",
		},
	],
};
const PLAN_TEXT = JSON.stringify(PLAN);

// A launched:false dry-run result for the plan above, as runPlanStart returns it.
function dryResult(
	overrides: Partial<Extract<PlanStartResult, { launched: false }>> = {},
): PlanStartResult {
	const plan: NormalizedPlan = parsePlan(PLAN);
	return {
		launched: false,
		strategy: "plan",
		plan,
		base: { ref: "HEAD", sha: "0".repeat(40) },
		approvalHash: "deadbeef",
		...overrides,
	};
}

// Build deps with recording fakes; override either to exercise a specific path.
function makeDeps(over: Partial<OrchestrateDeps> = {}): {
	deps: OrchestrateDeps;
	plannerCalls: PlannerRunArgs[];
	dryCalls: Array<{
		input: { plan: Record<string, unknown>; baseBranch?: string; maxIterations?: number };
		cwd: string;
	}>;
} {
	const plannerCalls: PlannerRunArgs[] = [];
	const dryCalls: Array<{
		input: { plan: Record<string, unknown>; baseBranch?: string; maxIterations?: number };
		cwd: string;
	}> = [];
	const deps: OrchestrateDeps = {
		runPlanner: (args) => {
			plannerCalls.push(args);
			return PLAN_TEXT;
		},
		dryRunPlan: (input, cwd) => {
			dryCalls.push({ input, cwd });
			return dryResult();
		},
		...over,
	};
	return { deps, plannerCalls, dryCalls };
}

describe("runOrchestrate", () => {
	test("runs the bundled planner, validates, dry-runs, and returns the reviewable result", async () => {
		const { deps, plannerCalls, dryCalls } = makeDeps();

		const result = await runOrchestrate(
			{ goal: "make it better", context: "use recipe x", baseBranch: "main", cwd: "/repo" },
			deps,
		);

		// The planner ran the bundled manifest with the goal/context/cwd.
		expect(plannerCalls).toHaveLength(1);
		expect(plannerCalls[0]).toEqual({
			manifestPath: PLAN_AUTHOR_MANIFEST_PATH,
			goal: "make it better",
			context: "use recipe x",
			cwd: "/repo",
		});

		// The dry run got the parsed plan object + base, and NO confirm (it is a preview).
		expect(dryCalls).toHaveLength(1);
		expect(dryCalls[0].cwd).toBe("/repo");
		expect(dryCalls[0].input.baseBranch).toBe("main");
		expect(dryCalls[0].input.plan).toEqual(PLAN);
		expect("confirm" in dryCalls[0].input).toBe(false);

		// The result carries the normalized plan, resolved base, hash, and next steps.
		expect(result.plan).toEqual(parsePlan(PLAN));
		expect(result.base).toEqual({ ref: "HEAD", sha: "0".repeat(40) });
		expect(result.approvalHash).toBe("deadbeef");
		expect(result.nextSteps).toContain("deadbeef");
		expect(result.nextSteps).toContain("confirm:true");
		// The base was overridden, so the instructions must name it -- confirming without
		// the same base_branch would recompute a different hash and refuse the start.
		expect(result.nextSteps).toContain("base_branch:main");
		// No recipes/manifests bound for this plan, so neither key is present.
		expect("recipes" in result).toBe(false);
		expect("manifests" in result).toBe(false);
	});

	test("omits context in the planner call and baseBranch in the dry run when absent", async () => {
		const { deps, plannerCalls, dryCalls } = makeDeps();

		const result = await runOrchestrate({ goal: "just the goal", cwd: "/repo" }, deps);

		expect("context" in plannerCalls[0]).toBe(false);
		expect("baseBranch" in dryCalls[0].input).toBe(false);
		// No base override, so the instructions must not name a base_branch (there is none
		// to repeat; chit_plan_start resolves the plan's own base / HEAD as the dry run did).
		expect(result.nextSteps).not.toContain("base_branch");
	});

	test("threads max_iterations into the dry run and names it in the confirm instructions", async () => {
		const { deps, dryCalls } = makeDeps();

		const result = await runOrchestrate({ goal: "g", maxIterations: 5, cwd: "/repo" }, deps);

		// The dry run hashed against this budget, so it must reach runPlanStart...
		expect(dryCalls[0].input.maxIterations).toBe(5);
		// ...and the confirm instructions must name it so the operator repeats it (else the hash differs).
		expect(result.nextSteps).toContain("max_iterations:5");
	});

	test("omits max_iterations in the dry run and instructions when absent", async () => {
		const { deps, dryCalls } = makeDeps();

		const result = await runOrchestrate({ goal: "g", cwd: "/repo" }, deps);

		expect("maxIterations" in dryCalls[0].input).toBe(false);
		expect(result.nextSteps).not.toContain("max_iterations");
	});

	test("passes through resolved recipes and manifest bindings from the dry run", async () => {
		const recipes = {
			"step-one": { id: "fast", mode: "converge" as const, maxIterations: 3 },
		};
		const manifests = {
			"step-one": {
				manifestPath: "recipes/fast.json",
				source: "git" as const,
				manifestDigest: "sha256:abc",
				participants: {},
			},
		};
		const { deps } = makeDeps({
			dryRunPlan: () => dryResult({ recipes, manifests }),
		});

		const result = await runOrchestrate({ goal: "g", cwd: "/repo" }, deps);

		expect(result.recipes).toEqual(recipes);
		expect(result.manifests).toEqual(manifests);
	});

	test("rejects invalid planner JSON without dry-running", async () => {
		let dryRan = false;
		const deps: OrchestrateDeps = {
			runPlanner: () => "this is not json {",
			dryRunPlan: () => {
				dryRan = true;
				return dryResult();
			},
		};

		await expect(runOrchestrate({ goal: "g", cwd: "/repo" }, deps)).rejects.toBeInstanceOf(
			OrchestrateError,
		);
		await expect(runOrchestrate({ goal: "g", cwd: "/repo" }, deps)).rejects.toThrow(
			/did not return valid JSON/,
		);
		expect(dryRan).toBe(false);
	});

	test("rejects a structurally invalid plan (valid JSON, bad plan) without dry-running", async () => {
		let dryRan = false;
		const deps: OrchestrateDeps = {
			// Valid JSON, but missing the required `title` -> parsePlan rejects it.
			runPlanner: () => JSON.stringify({ schema: 1, steps: [] }),
			dryRunPlan: () => {
				dryRan = true;
				return dryResult();
			},
		};

		await expect(runOrchestrate({ goal: "g", cwd: "/repo" }, deps)).rejects.toBeInstanceOf(
			OrchestrateError,
		);
		await expect(runOrchestrate({ goal: "g", cwd: "/repo" }, deps)).rejects.toThrow(/invalid plan/);
		expect(dryRan).toBe(false);
	});

	test("refuses if the dry run unexpectedly launched", async () => {
		const { deps } = makeDeps({
			dryRunPlan: () =>
				({
					launched: true,
					view: { id: "p1" },
					base: { ref: "HEAD", sha: "0".repeat(40) },
					approvalHash: "deadbeef",
				}) as unknown as PlanStartResult,
		});

		await expect(runOrchestrate({ goal: "g", cwd: "/repo" }, deps)).rejects.toThrow(
			/unexpectedly launched/,
		);
	});

	test("awaits an async planner runner", async () => {
		const { deps } = makeDeps({
			runPlanner: async () => PLAN_TEXT,
		});

		const result = await runOrchestrate({ goal: "g", cwd: "/repo" }, deps);
		expect(result.approvalHash).toBe("deadbeef");
	});
});
