import { describe, expect, test } from "bun:test";
import {
	buildPlanApprovalArtifact,
	canonicalApprovalPayload,
	type PlanApprovalBase,
} from "./approval.ts";
import { parsePlan } from "./parse.ts";

// The native plan approval artifact binds a confirmed chit_plan_start to exactly what the
// dry run showed: the normalized plan, the resolved base commit, and the launch-time
// iteration budget. These tests pin the canonical-payload contract the hash is computed
// over: key-order independence, and a different payload for any material change.

const PLAN = {
	schema: 1 as const,
	title: "Wire the feature",
	steps: [
		{ id: "scaffold", title: "Scaffold", body: "Create the module" },
		{ id: "impl", title: "Implement", body: "Do the work", dependsOn: ["scaffold"] },
	],
};

const BASE: PlanApprovalBase = { ref: "HEAD", sha: "abc123" };

function payloadFor(plan: unknown, base: PlanApprovalBase, maxIterations?: number): string {
	return canonicalApprovalPayload(buildPlanApprovalArtifact(parsePlan(plan), base, maxIterations));
}

describe("canonicalApprovalPayload determinism", () => {
	test("key order in the source plan does not change the payload", () => {
		const a = payloadFor(PLAN, BASE);
		// The same plan, every object's keys reversed: a different insertion order, identical value.
		const reordered = {
			steps: [
				{ body: "Create the module", title: "Scaffold", id: "scaffold" },
				{ dependsOn: ["scaffold"], body: "Do the work", title: "Implement", id: "impl" },
			],
			title: "Wire the feature",
			schema: 1,
		};
		expect(payloadFor(reordered, BASE)).toBe(a);
	});

	test("a material change to the plan changes the payload", () => {
		const base = payloadFor(PLAN, BASE);
		const changed = payloadFor(
			{ ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[1], body: "Do the work DIFFERENTLY" }] },
			BASE,
		);
		expect(changed).not.toBe(base);
	});

	test("a changed base ref or moved base sha changes the payload", () => {
		const first = payloadFor(PLAN, { ref: "main", sha: "abc123" });
		expect(payloadFor(PLAN, { ref: "release", sha: "abc123" })).not.toBe(first);
		expect(payloadFor(PLAN, { ref: "main", sha: "def456" })).not.toBe(first);
	});

	test("the launch-time maxIterations is bound into the payload", () => {
		const none = payloadFor(PLAN, BASE);
		const three = payloadFor(PLAN, BASE, 3);
		const five = payloadFor(PLAN, BASE, 5);
		expect(three).not.toBe(none);
		expect(five).not.toBe(three);
	});

	test("an absent maxIterations and an explicit undefined produce the same payload", () => {
		expect(payloadFor(PLAN, BASE, undefined)).toBe(payloadFor(PLAN, BASE));
	});

	test("the payload is valid canonical JSON of the artifact", () => {
		const artifact = buildPlanApprovalArtifact(parsePlan(PLAN), BASE, 3);
		expect(JSON.parse(canonicalApprovalPayload(artifact))).toEqual(
			JSON.parse(JSON.stringify(artifact)),
		);
	});
});
