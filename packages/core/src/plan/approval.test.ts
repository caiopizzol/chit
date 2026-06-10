import { describe, expect, test } from "bun:test";
import type { ManifestBinding } from "../manifest/binding.ts";
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

	test("adding or changing a step commitMessage changes the payload", () => {
		const base = payloadFor(PLAN, BASE);
		const withMessage = payloadFor(
			{
				...PLAN,
				steps: [
					{ ...PLAN.steps[0], commitMessage: "feat(core): scaffold the module" },
					PLAN.steps[1],
				],
			},
			BASE,
		);
		expect(withMessage).not.toBe(base);
		const changedMessage = payloadFor(
			{
				...PLAN,
				steps: [
					{ ...PLAN.steps[0], commitMessage: "chore(core): scaffold the module" },
					PLAN.steps[1],
				],
			},
			BASE,
		);
		expect(changedMessage).not.toBe(withMessage);
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

	// The manifest binding closes the path-only hole: an edited manifest (a different
	// content digest) or a config change that re-routes participants must move the
	// payload, so a confirm with the old hash is refused.
	const BINDING: ManifestBinding = {
		manifestPath: "manifests/converge.json",
		source: "git",
		manifestDigest: "sha256:aaaa",
		participants: {
			implementer: {
				agentId: "claude",
				adapter: "claude-cli",
				session: "per_scope",
				permissions: { filesystem: "write" },
				enforcesReadOnly: false,
				config: { model: "opus" },
			},
		},
	};

	test("binding a step manifest changes the payload; an empty map does not", () => {
		const none = payloadFor(PLAN, BASE);
		expect(
			canonicalApprovalPayload(
				buildPlanApprovalArtifact(parsePlan(PLAN), BASE, undefined, { impl: BINDING }),
			),
		).not.toBe(none);
		expect(
			canonicalApprovalPayload(buildPlanApprovalArtifact(parsePlan(PLAN), BASE, undefined, {})),
		).toBe(none);
	});

	test("a changed manifest digest or participant summary changes the payload", () => {
		const bound = canonicalApprovalPayload(
			buildPlanApprovalArtifact(parsePlan(PLAN), BASE, undefined, { impl: BINDING }),
		);
		expect(
			canonicalApprovalPayload(
				buildPlanApprovalArtifact(parsePlan(PLAN), BASE, undefined, {
					impl: { ...BINDING, manifestDigest: "sha256:bbbb" },
				}),
			),
		).not.toBe(bound);
		expect(
			canonicalApprovalPayload(
				buildPlanApprovalArtifact(parsePlan(PLAN), BASE, undefined, {
					impl: {
						...BINDING,
						participants: {
							implementer: {
								...BINDING.participants.implementer,
								config: { model: "haiku" },
							},
						},
					},
				}),
			),
		).not.toBe(bound);
	});
});
