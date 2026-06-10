import { describe, expect, test } from "bun:test";
import { PlanError, parsePlan } from "./parse.ts";

const VALID_MINIMAL = {
	schema: 1,
	title: "Add session auth",
	steps: [{ id: "schema", title: "Add users table", body: "Add the users table and migration." }],
};

function expectPlanError(raw: unknown, pathFragment: string, msgFragment?: string): void {
	let caught: unknown;
	try {
		parsePlan(raw);
	} catch (e) {
		caught = e;
	}
	if (!(caught instanceof PlanError)) {
		throw new Error(
			`expected PlanError; got ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	expect(caught.path).toContain(pathFragment);
	if (msgFragment) expect(caught.message).toContain(msgFragment);
}

describe("valid plans", () => {
	test("minimal plan parses with defaults", () => {
		const plan = parsePlan(VALID_MINIMAL);
		expect(plan.schema).toBe(1);
		expect(plan.title).toBe("Add session auth");
		expect(plan.cleanup).toBe("after_apply");
		expect(plan.apply).toBeUndefined();
		expect(plan.id).toBeUndefined();
		expect(plan.baseBranch).toBeUndefined();
		expect(plan.steps).toHaveLength(1);
		expect(plan.steps[0]?.dependsOn).toEqual([]);
		expect(plan.steps[0]?.requiredChecks).toBeUndefined();
	});

	test("plan with all optional fields parses", () => {
		const plan = parsePlan({
			schema: 1,
			id: "add-auth",
			title: "Add session auth",
			baseBranch: "main",
			steps: [
				{
					id: "schema",
					title: "Add users table",
					body: "Add the users table and migration.",
					dependsOn: [],
					requiredChecks: [
						{ command: "bun", args: ["run", "check"], name: "check", timeoutMs: 1000 },
					],
					manifestPath: "manifests/converge.json",
					maxIterations: 5,
					callTimeoutMs: 900000,
				},
				{
					id: "endpoints",
					title: "Add login/logout endpoints",
					body: "Add the endpoints.",
					dependsOn: ["schema"],
				},
			],
			apply: "gated",
			cleanup: "manual",
		});
		expect(plan.id).toBe("add-auth");
		expect(plan.baseBranch).toBe("main");
		expect(plan.apply).toBe("gated");
		expect(plan.cleanup).toBe("manual");
		const schema = plan.steps[0];
		expect(schema?.requiredChecks?.[0]).toEqual({
			command: "bun",
			args: ["run", "check"],
			name: "check",
			timeoutMs: 1000,
		});
		expect(schema?.manifestPath).toBe("manifests/converge.json");
		expect(schema?.maxIterations).toBe(5);
		expect(schema?.callTimeoutMs).toBe(900000);
		expect(plan.steps[1]?.dependsOn).toEqual(["schema"]);
	});

	test("requiredChecks args defaults to []", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", requiredChecks: [{ command: "make" }] }],
		});
		expect(plan.steps[0]?.requiredChecks?.[0]).toEqual({ command: "make", args: [] });
	});

	test("a step commitMessage is preserved on the normalized step", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [
				{ id: "s", title: "t", body: "b", commitMessage: "feat(auth): add users table" },
				{ id: "s2", title: "t2", body: "b2" },
			],
		});
		expect(plan.steps[0]?.commitMessage).toBe("feat(auth): add users table");
		expect(plan.steps[1]?.commitMessage).toBeUndefined();
	});

	test("a step commitMessage is trimmed before approval", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", commitMessage: "  feat(auth): add users table  " }],
		});
		expect(plan.steps[0]?.commitMessage).toBe("feat(auth): add users table");
	});

	test("duplicate dependsOn entries are de-duplicated", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [
				{ id: "a", title: "t", body: "b" },
				{ id: "b", title: "t", body: "b", dependsOn: ["a", "a"] },
			],
		});
		expect(plan.steps[1]?.dependsOn).toEqual(["a"]);
	});
});

describe("invalid plans fail with useful errors", () => {
	test("not an object", () => {
		expectPlanError([], "$", "JSON object");
	});

	test("unsupported schema", () => {
		expectPlanError({ ...VALID_MINIMAL, schema: 2 }, "schema", "must be 1");
	});

	test("unknown top-level field", () => {
		expectPlanError({ ...VALID_MINIMAL, extra: 1 }, "extra", "unknown top-level field");
	});

	test("missing title", () => {
		const bad: Record<string, unknown> = { ...VALID_MINIMAL };
		delete bad.title;
		expectPlanError(bad, "title", "non-empty string");
	});

	test("missing steps", () => {
		const bad: Record<string, unknown> = { ...VALID_MINIMAL };
		delete bad.steps;
		expectPlanError(bad, "steps", "must be an array");
	});

	test("empty steps", () => {
		expectPlanError({ ...VALID_MINIMAL, steps: [] }, "steps", "at least one step");
	});

	test("step missing id", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ title: "t", body: "b" }] },
			"steps[0].id",
			"non-empty string",
		);
	});

	test("step bad id slug", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "bad id", title: "t", body: "b" }] },
			"steps[0].id",
			"safe slug",
		);
	});

	test("reserved step id", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "constructor", title: "t", body: "b" }] },
			"steps[0].id",
			"reserved name",
		);
	});

	test("duplicate step ids", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [
					{ id: "s", title: "t", body: "b" },
					{ id: "s", title: "t2", body: "b2" },
				],
			},
			"steps[1].id",
			"duplicate step id",
		);
	});

	test("missing dependency", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", dependsOn: ["nope"] }] },
			"steps.s.dependsOn",
			'unknown step "nope"',
		);
	});

	test("self dependency", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", dependsOn: ["s"] }] },
			"steps.s.dependsOn",
			"depends on itself",
		);
	});

	test("dependency cycle", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [
					{ id: "a", title: "t", body: "b", dependsOn: ["b"] },
					{ id: "b", title: "t", body: "b", dependsOn: ["a"] },
				],
			},
			"steps",
			"dependency cycle",
		);
	});

	test("unknown step field", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", extra: 1 }] },
			"steps[0].extra",
			"unknown field",
		);
	});

	test("unsupported apply policy", () => {
		expectPlanError({ ...VALID_MINIMAL, apply: "auto-on-clean" }, "apply", "gated");
	});

	test("invalid cleanup policy", () => {
		expectPlanError({ ...VALID_MINIMAL, cleanup: "never" }, "cleanup", "must be one of");
	});

	test("invalid requiredChecks (unknown field)", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [{ id: "s", title: "t", body: "b", requiredChecks: [{ command: "bun", cwd: "." }] }],
			},
			"steps.s.requiredChecks[0].cwd",
			"unknown field",
		);
	});

	test("empty commitMessage", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", commitMessage: "" }] },
			"steps.s.commitMessage",
			"non-blank string",
		);
	});

	test("blank (whitespace-only) commitMessage", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", commitMessage: "   " }] },
			"steps.s.commitMessage",
			"non-blank string",
		);
	});

	test("non-string commitMessage", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", commitMessage: 7 }] },
			"steps.s.commitMessage",
			"non-blank string",
		);
	});

	test("multiline commitMessage", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [{ id: "s", title: "t", body: "b", commitMessage: "feat: x\n\nbody text" }],
			},
			"steps.s.commitMessage",
			"single line",
		);
	});

	test("invalid maxIterations", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", maxIterations: 0 }] },
			"steps.s.maxIterations",
			"integer >= 1",
		);
	});

	test("invalid callTimeoutMs", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", callTimeoutMs: 1.5 }] },
			"steps.s.callTimeoutMs",
			"integer >= 1",
		);
	});

	test("bad plan id slug", () => {
		expectPlanError({ ...VALID_MINIMAL, id: "Add Auth" }, "id", "kebab-case");
	});
});
