import { describe, expect, test } from "bun:test";
import { derivePlanStatus, selectNextStep } from "./schedule.ts";
import type { Plan, PlanStepRecord, PlanStepStatus } from "./types.ts";

function step(id: string, over: Partial<PlanStepRecord> = {}): PlanStepRecord {
	return { id, title: id, body: "b", dependsOn: [], status: "pending", ...over };
}

function plan(steps: PlanStepRecord[], over: Partial<Plan> = {}): Plan {
	return {
		schema: 1,
		id: "p",
		repo: "/repo",
		callerCheckout: "/repo",
		repoKey: "k",
		title: "t",
		apply: "gated",
		cleanup: "after_apply",
		baseBranch: "main",
		baseSha: "abc",
		integrationBranch: "chit/plan/p",
		status: "running",
		steps,
		createdAt: "t",
		updatedAt: "t",
		...over,
	};
}

describe("selectNextStep", () => {
	test("strict chain: the earliest launchable pending step is selected", () => {
		const p = plan([step("a"), step("b", { dependsOn: ["a"] })]);
		expect(selectNextStep(p)?.id).toBe("a");
	});

	test("a dependent launches only after its dependency is APPLIED, not review_ready", () => {
		// review_ready does not satisfy a code dependency; it also blocks new launches, so the
		// dependent stays unselected until the dependency is applied to the integration branch.
		const reviewed = plan([step("a", { status: "review_ready" }), step("b", { dependsOn: ["a"] })]);
		expect(selectNextStep(reviewed)).toBeUndefined();
		const applied = plan([step("a", { status: "applied" }), step("b", { dependsOn: ["a"] })]);
		expect(selectNextStep(applied)?.id).toBe("b");
	});

	test("a pending dependency is not yet applied, so the dependent is not selected", () => {
		// Isolated from the launch-block guard: no step is in flight or paused, yet `b` is not
		// selected because its dependency `a` is still pending (not applied) -- `a` launches first.
		const p = plan([step("a"), step("b", { dependsOn: ["a"] })]);
		expect(selectNextStep(p)?.id).toBe("a");
	});

	test("a running step blocks any new launch", () => {
		const p = plan([step("a", { status: "running" }), step("b", { dependsOn: ["a"] })]);
		expect(selectNextStep(p)).toBeUndefined();
	});

	test("a needs_human / failed / cancelled step pauses the plan (no new launch)", () => {
		for (const blocked of ["needs_human", "failed", "cancelled"] as PlanStepStatus[]) {
			// `a` is paused and `b` is independent with its deps met, but v1 pauses plan-wide
			// rather than skipping ahead to `b`.
			const p = plan([step("a", { status: blocked }), step("b")]);
			expect(selectNextStep(p)).toBeUndefined();
		}
	});

	test("independent ready steps do not run as a wave: only one step is selected", () => {
		// Two independent steps are both launchable; v1 selects exactly one (waves are slice 3).
		const p = plan([step("a"), step("b")]);
		expect(selectNextStep(p)?.id).toBe("a");
	});

	test("no pending steps left: nothing to select", () => {
		const p = plan([step("a", { status: "applied" })]);
		expect(selectNextStep(p)).toBeUndefined();
	});
});

describe("derivePlanStatus", () => {
	test("running while a step is advancing or a step can launch next", () => {
		expect(derivePlanStatus(plan([step("a", { status: "running" }), step("b")]))).toBe("running");
		expect(derivePlanStatus(plan([step("a")]))).toBe("running"); // launchable
	});

	test("a review_ready step waits on the operator's gated apply", () => {
		const p = plan([step("a", { status: "review_ready" }), step("b", { dependsOn: ["a"] })]);
		expect(derivePlanStatus(p)).toBe("ready_for_apply");
	});

	test("completed only when every step is applied", () => {
		expect(derivePlanStatus(plan([step("a", { status: "applied" })]))).toBe("completed");
		// One step still pending -> not completed.
		const partial = plan([step("a", { status: "applied" }), step("b", { dependsOn: ["a"] })]);
		expect(derivePlanStatus(partial)).toBe("running");
	});

	test("needs_human / failed / cancelled each pause the plan", () => {
		expect(derivePlanStatus(plan([step("a", { status: "needs_human" }), step("b")]))).toBe(
			"needs_human",
		);
		expect(derivePlanStatus(plan([step("a", { status: "failed" }), step("b")]))).toBe("failed");
		expect(derivePlanStatus(plan([step("a", { status: "cancelled" }), step("b")]))).toBe(
			"cancelled",
		);
	});

	test("a non-clean step outranks a forward signal (verdict integrity)", () => {
		// A failed step alongside an applied one must not read as "running"/"ready"; the plan
		// pauses on the failure so the operator decides.
		expect(
			derivePlanStatus(plan([step("a", { status: "applied" }), step("b", { status: "failed" })])),
		).toBe("failed");
		// cancelled settles the whole plan, outranking a co-present failure.
		expect(
			derivePlanStatus(plan([step("a", { status: "cancelled" }), step("b", { status: "failed" })])),
		).toBe("cancelled");
	});
});
