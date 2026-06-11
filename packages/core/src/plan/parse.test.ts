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

	test("a step recipe id is preserved on the normalized step", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [
				{ id: "s", title: "t", body: "b", recipe: "deep-feature" },
				{ id: "s2", title: "t2", body: "b2" },
			],
		});
		expect(plan.steps[0]?.recipe).toBe("deep-feature");
		expect(plan.steps[1]?.recipe).toBeUndefined();
	});

	test("a recipe-backed step may still override the runtime budgets", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [
				{
					id: "s",
					title: "t",
					body: "b",
					recipe: "deep-feature",
					maxIterations: 5,
					callTimeoutMs: 900000,
				},
			],
		});
		expect(plan.steps[0]?.recipe).toBe("deep-feature");
		expect(plan.steps[0]?.maxIterations).toBe(5);
		expect(plan.steps[0]?.callTimeoutMs).toBe(900000);
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

	test("a step naming both recipe and manifestPath is rejected", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [
					{
						id: "s",
						title: "t",
						body: "b",
						recipe: "deep-feature",
						manifestPath: "manifests/converge.json",
					},
				],
			},
			"steps.s.recipe",
			"mutually exclusive",
		);
	});

	test("non-string recipe", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", recipe: 7 }] },
			"steps.s.recipe",
			"non-empty string",
		);
	});

	test("a recipe that is not a kebab-case id is rejected (a path cannot pose as a recipe)", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [{ id: "s", title: "t", body: "b", recipe: "manifests/converge.json" }],
			},
			"steps.s.recipe",
			"kebab-case",
		);
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", recipe: "Deep-Feature" }] },
			"steps.s.recipe",
			"kebab-case",
		);
	});
});

// A producing step declares handoffs; a later step consumes them. The producer/consumer
// pair below is reused by the valid-edge and approval tests.
const HANDOFF_PLAN = {
	schema: 1 as const,
	title: "Investigate then fix",
	steps: [
		{
			id: "investigate",
			title: "Find the failing surfaces",
			body: "Investigate and produce a findings handoff.",
			handoffs: { findings: { path: "findings.json", format: "json", maxBytes: 65536 } },
		},
		{
			id: "implement",
			title: "Fix the findings",
			body: "Use the findings handoff.",
			dependsOn: ["investigate"],
			consumes: [{ step: "investigate", handoff: "findings", as: "findings" }],
		},
	],
};

describe("valid handoff declarations and consume edges", () => {
	test("a producer declares a handoff and a dependent consumes it", () => {
		const plan = parsePlan(HANDOFF_PLAN);
		expect(plan.steps[0]?.handoffs).toEqual({
			findings: { path: "findings.json", format: "json", maxBytes: 65536 },
		});
		expect(plan.steps[1]?.consumes).toEqual([
			{ step: "investigate", handoff: "findings", as: "findings" },
		]);
		// the per-step total budget defaults onto the consuming step only
		expect(plan.steps[1]?.maxConsumedBytes).toBe(256 * 1024);
		expect(plan.steps[0]?.maxConsumedBytes).toBeUndefined();
	});

	test("handoff maxBytes and format default when absent", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", handoffs: { out: { path: "out.json" } } }],
		});
		expect(plan.steps[0]?.handoffs?.out).toEqual({
			path: "out.json",
			format: "json",
			maxBytes: 64 * 1024,
		});
	});

	test("a nested relative handoff path is accepted", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", handoffs: { out: { path: "reports/out.json" } } }],
		});
		expect(plan.steps[0]?.handoffs?.out?.path).toBe("reports/out.json");
	});

	test("an author maxConsumedBytes overrides the default budget", () => {
		const plan = parsePlan({
			...HANDOFF_PLAN,
			steps: [HANDOFF_PLAN.steps[0], { ...HANDOFF_PLAN.steps[1], maxConsumedBytes: 4096 }],
		});
		expect(plan.steps[1]?.maxConsumedBytes).toBe(4096);
	});

	test("an empty handoffs map and empty consumes array normalize to absent", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", handoffs: {}, consumes: [] }],
		});
		expect(plan.steps[0]?.handoffs).toBeUndefined();
		expect(plan.steps[0]?.consumes).toBeUndefined();
		expect(plan.steps[0]?.maxConsumedBytes).toBeUndefined();
	});
});

describe("invalid handoff declarations fail with useful errors", () => {
	function handoffStep(decl: unknown): unknown {
		return {
			...VALID_MINIMAL,
			steps: [{ id: "s", title: "t", body: "b", handoffs: { out: decl } }],
		};
	}

	test("absolute path", () => {
		expectPlanError(
			handoffStep({ path: "/etc/passwd" }),
			"steps.s.handoffs.out.path",
			"not absolute",
		);
	});

	test("backslash path", () => {
		expectPlanError(
			handoffStep({ path: "reports\\out.json" }),
			"steps.s.handoffs.out.path",
			"backslash",
		);
	});

	test("Windows drive path", () => {
		expectPlanError(handoffStep({ path: "C:/out.json" }), "steps.s.handoffs.out.path", "drive");
	});

	test("dotdot traversal segment", () => {
		expectPlanError(
			handoffStep({ path: "../escape.json" }),
			"steps.s.handoffs.out.path",
			"'.' or '..'",
		);
	});

	test("dot segment", () => {
		expectPlanError(
			handoffStep({ path: "./out.json" }),
			"steps.s.handoffs.out.path",
			"'.' or '..'",
		);
	});

	test("empty segment", () => {
		expectPlanError(
			handoffStep({ path: "reports//out.json" }),
			"steps.s.handoffs.out.path",
			"empty path segments",
		);
	});

	test("path under .git", () => {
		expectPlanError(handoffStep({ path: ".git/config" }), "steps.s.handoffs.out.path", ".git");
		expectPlanError(
			handoffStep({ path: "reports/.git/config" }),
			"steps.s.handoffs.out.path",
			".git",
		);
	});

	test("non-json format", () => {
		expectPlanError(
			handoffStep({ path: "out.json", format: "yaml" }),
			"steps.s.handoffs.out.format",
			"json",
		);
	});

	test("maxBytes must be a positive integer", () => {
		expectPlanError(
			handoffStep({ path: "out.json", maxBytes: 0 }),
			"steps.s.handoffs.out.maxBytes",
			"integer >= 1",
		);
	});

	test("unknown handoff field", () => {
		expectPlanError(
			handoffStep({ path: "out.json", schema: "x" }),
			"steps.s.handoffs.out.schema",
			"unknown field",
		);
	});

	test("bad handoff id slug", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [{ id: "s", title: "t", body: "b", handoffs: { "bad id": { path: "out.json" } } }],
			},
			"steps.s.handoffs.bad id",
			"safe slug",
		);
	});

	test("maxConsumedBytes without consumes is rejected", () => {
		expectPlanError(
			{ ...VALID_MINIMAL, steps: [{ id: "s", title: "t", body: "b", maxConsumedBytes: 4096 }] },
			"steps.s.maxConsumedBytes",
			"only valid on a step that consumes",
		);
	});
});

describe("invalid consume edges fail with useful errors", () => {
	function consumeStep(consumes: unknown, extra?: Record<string, unknown>): unknown {
		return {
			...VALID_MINIMAL,
			steps: [
				{
					id: "investigate",
					title: "t",
					body: "b",
					handoffs: { findings: { path: "findings.json" } },
				},
				{
					id: "implement",
					title: "t",
					body: "b",
					dependsOn: ["investigate"],
					consumes,
					...extra,
				},
			],
		};
	}

	test("references an unknown producing step", () => {
		expectPlanError(
			consumeStep([{ step: "nope", handoff: "findings", as: "findings" }]),
			"steps.implement.consumes[0].step",
			'unknown step "nope"',
		);
	});

	test("references a handoff the producer does not declare", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "ghost", as: "findings" }]),
			"steps.implement.consumes[0].handoff",
			'does not declare a handoff "ghost"',
		);
	});

	test("an inherited prototype key is not a declared handoff (toString)", () => {
		// "toString" passes the safe-slug check and is not a reserved name, so it reaches the
		// declaration check. The producer declares only "findings", so an own-property lookup
		// must reject it rather than matching Object.prototype.toString.
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "toString", as: "data" }]),
			"steps.implement.consumes[0].handoff",
			'does not declare a handoff "toString"',
		);
	});

	test("a reserved-name handoff reference is rejected at parse (constructor)", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "constructor", as: "data" }]),
			"steps.implement.consumes[0].handoff",
			"must not be a reserved name",
		);
	});

	test("a non-slug handoff reference is rejected", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "not a slug", as: "data" }]),
			"steps.implement.consumes[0].handoff",
			"safe slug",
		);
	});

	test("a step cannot consume its own handoff", () => {
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [
					{
						id: "s",
						title: "t",
						body: "b",
						handoffs: { findings: { path: "findings.json" } },
						consumes: [{ step: "s", handoff: "findings", as: "findings" }],
					},
				],
			},
			"steps.s.consumes[0].step",
			"cannot consume its own handoff",
		);
	});

	test("producer outside the dependsOn closure is rejected", () => {
		// implement does NOT dependsOn investigate, so the handoff would bypass the code graph
		expectPlanError(
			{
				...VALID_MINIMAL,
				steps: [
					{
						id: "investigate",
						title: "t",
						body: "b",
						handoffs: { findings: { path: "findings.json" } },
					},
					{
						id: "implement",
						title: "t",
						body: "b",
						consumes: [{ step: "investigate", handoff: "findings", as: "findings" }],
					},
				],
			},
			"steps.implement.consumes[0].step",
			"dependsOn closure",
		);
	});

	test("a transitive dependency satisfies the closure", () => {
		const plan = parsePlan({
			...VALID_MINIMAL,
			steps: [
				{
					id: "investigate",
					title: "t",
					body: "b",
					handoffs: { findings: { path: "findings.json" } },
				},
				{ id: "middle", title: "t", body: "b", dependsOn: ["investigate"] },
				{
					id: "implement",
					title: "t",
					body: "b",
					dependsOn: ["middle"],
					consumes: [{ step: "investigate", handoff: "findings", as: "findings" }],
				},
			],
		});
		expect(plan.steps[2]?.consumes?.[0]?.step).toBe("investigate");
	});

	test("duplicate aliases on one step are rejected", () => {
		expectPlanError(
			consumeStep([
				{ step: "investigate", handoff: "findings", as: "findings" },
				{ step: "investigate", handoff: "findings", as: "findings" },
			]),
			"steps.implement.consumes[1].as",
			"duplicate consume alias",
		);
	});

	test("a bad alias slug is rejected", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "findings", as: "bad alias" }]),
			"steps.implement.consumes[0].as",
			"safe slug",
		);
	});

	test("unknown consume field", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "findings", as: "findings", extra: 1 }]),
			"steps.implement.consumes[0].extra",
			"unknown field",
		);
	});

	test("missing consume alias", () => {
		expectPlanError(
			consumeStep([{ step: "investigate", handoff: "findings" }]),
			"steps.implement.consumes[0].as",
			"non-empty string",
		);
	});
});
