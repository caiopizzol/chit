import { describe, expect, test } from "bun:test";
import { DraftError, parseDraft } from "./parse.ts";

// parseDraft validates a planner draft STRUCTURALLY: schema, strategy, safe unique
// ids, both dependency kinds resolving and acyclic. Strategy-specific semantics
// (code deps in a batch, claims, plan-only fields) are the compilers' job and are
// tested in compile.test.ts. These tests pin the structural contract.

const PLAN_MIN = {
	schema: 1,
	strategy: "plan",
	title: "Add a feature",
	steps: [{ id: "schema", title: "Schema", body: "Add the table." }],
};

function expectDraftError(raw: unknown, pathFragment: string): void {
	try {
		parseDraft(raw);
	} catch (e) {
		expect(e).toBeInstanceOf(DraftError);
		expect((e as DraftError).message).toContain(pathFragment);
		return;
	}
	throw new Error("expected parseDraft to throw");
}

describe("parseDraft: shape", () => {
	test("a minimal plan draft parses and defaults dep lists to []", () => {
		const d = parseDraft(PLAN_MIN);
		expect(d.strategy).toBe("plan");
		expect(d.title).toBe("Add a feature");
		expect(d.steps).toHaveLength(1);
		expect(d.steps[0]?.codeDependsOn).toEqual([]);
		expect(d.steps[0]?.orderDependsOn).toEqual([]);
	});

	test("a batch draft with claims and optional fields parses", () => {
		const d = parseDraft({
			schema: 1,
			strategy: "batch",
			title: "Parallel work",
			steps: [
				{
					id: "a",
					title: "A",
					body: "do a",
					profileId: "deep-converge",
					claimedPaths: ["src/a/**"],
					callTimeoutMs: 60000,
					requiredChecks: [{ command: "bun", args: ["test"], name: "unit" }],
				},
				{ id: "b", title: "B", body: "do b", claimedPaths: ["src/b/**"], orderDependsOn: ["a"] },
			],
		});
		expect(d.steps[0]?.profileId).toBe("deep-converge");
		expect(d.steps[0]?.requiredChecks?.[0]?.command).toBe("bun");
		expect(d.steps[1]?.orderDependsOn).toEqual(["a"]);
	});

	test("non-object draft is rejected", () => expectDraftError(42, "draft must be a JSON object"));
	test("unknown top-level field is rejected", () =>
		expectDraftError({ ...PLAN_MIN, bogus: 1 }, "bogus"));
	test("wrong schema is rejected", () => expectDraftError({ ...PLAN_MIN, schema: 2 }, "schema"));
	test("unknown strategy is rejected", () =>
		expectDraftError({ ...PLAN_MIN, strategy: "graph" }, "strategy"));
	test("empty title is rejected", () => expectDraftError({ ...PLAN_MIN, title: "" }, "title"));
	test("empty steps is rejected", () => expectDraftError({ ...PLAN_MIN, steps: [] }, "steps"));
});

describe("parseDraft: steps", () => {
	test("missing body is rejected", () =>
		expectDraftError({ ...PLAN_MIN, steps: [{ id: "a", title: "A" }] }, "body"));

	test("unsafe step id is rejected", () =>
		expectDraftError({ ...PLAN_MIN, steps: [{ id: "a/b", title: "A", body: "b" }] }, "safe slug"));

	test("reserved step id is rejected (passes the slug check but is a prototype key)", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "constructor", title: "A", body: "b" }] },
			"reserved",
		));

	test("duplicate step id is rejected", () =>
		expectDraftError(
			{
				...PLAN_MIN,
				steps: [
					{ id: "a", title: "A", body: "b" },
					{ id: "a", title: "A2", body: "b2" },
				],
			},
			"duplicate",
		));

	test("non-kebab profileId is rejected", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "a", title: "A", body: "b", profileId: "Deep" }] },
			"profileId",
		));

	test("non-integer maxIterations is rejected", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "a", title: "A", body: "b", maxIterations: 0 }] },
			"maxIterations",
		));

	test("a required check with an unknown field is rejected", () =>
		expectDraftError(
			{
				...PLAN_MIN,
				steps: [{ id: "a", title: "A", body: "b", requiredChecks: [{ command: "x", cwd: "/" }] }],
			},
			"cwd",
		));

	test("claimedPaths must be an array of strings", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "a", title: "A", body: "b", claimedPaths: [1] }] },
			"claimedPaths",
		));
});

describe("parseDraft: dependency graph", () => {
	test("a dependency on an unknown step is rejected", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "a", title: "A", body: "b", codeDependsOn: ["ghost"] }] },
			"unknown step",
		));

	test("a self dependency is rejected", () =>
		expectDraftError(
			{ ...PLAN_MIN, steps: [{ id: "a", title: "A", body: "b", orderDependsOn: ["a"] }] },
			"depends on itself",
		));

	test("the same id in both code and order deps is rejected", () =>
		expectDraftError(
			{
				schema: 1,
				strategy: "plan",
				title: "t",
				steps: [
					{ id: "a", title: "A", body: "b" },
					{ id: "b", title: "B", body: "b", codeDependsOn: ["a"], orderDependsOn: ["a"] },
				],
			},
			"pick one",
		));

	test("a cycle across mixed dependency kinds is rejected", () =>
		expectDraftError(
			{
				schema: 1,
				strategy: "plan",
				title: "t",
				steps: [
					{ id: "a", title: "A", body: "b", codeDependsOn: ["b"] },
					{ id: "b", title: "B", body: "b", orderDependsOn: ["a"] },
				],
			},
			"cycle",
		));
});
