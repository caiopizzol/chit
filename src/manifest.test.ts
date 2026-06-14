import { describe, expect, test } from "bun:test";
import {
	effectiveCallTimeoutMs,
	effectiveRunTimeoutMs,
	hasChecks,
	isComposition,
	isSandboxed,
	kindLabel,
	type Manifest,
	ManifestError,
	parseManifest,
} from "./manifest.ts";

// A text execution routine: call + format, read-only, no checks.
const TEXT = {
	id: "griller",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false } },
	participants: { griller: { agent: "claude", instructions: "Inspect.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "{{ steps.grill.output }}" },
	],
	output: "out",
};

// A loop execution routine: call/check + repeat. "build"/"verify" are step ids.
const LOOP = {
	id: "impl-review",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }} {{ iteration }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	repeat: { until: "checks-pass", maxIterations: 3 },
};

// A composition: only routine steps.
const COMP = {
	id: "feature-flow",
	inputs: { idea: { type: "string" } },
	steps: [
		{ id: "grill", routine: "feature-griller", inputs: { idea: "{{ inputs.idea }}" } },
		{ id: "impl", routine: "impl-review", inputs: { task: "{{ steps.grill.output }}" } },
	],
};

function parse(raw: unknown): Manifest {
	return parseManifest(raw, "test.json");
}

describe("parseManifest -- one shape, no policy", () => {
	test("rejects a `policy` field (it is derived, not written)", () => {
		expect(() => parse({ ...TEXT, policy: "one-shot" })).toThrow(/unknown field "policy"/);
	});

	test("parses a text execution routine and derives its shape", () => {
		const m = parse(TEXT);
		expect(m.steps.map((s) => [s.id, s.kind])).toEqual([
			["grill", "call"],
			["out", "format"],
		]);
		expect(m.output).toBe("out");
		expect(isComposition(m)).toBe(false);
		expect(hasChecks(m)).toBe(false);
		expect(isSandboxed(m)).toBe(false);
		expect(kindLabel(m)).toBe("text");
	});

	test("parses a loop execution routine; checks + repeat make it sandboxed", () => {
		const m = parse(LOOP);
		expect(m.repeat).toEqual({ until: "checks-pass", maxIterations: 3 });
		expect(hasChecks(m)).toBe(true);
		expect(isSandboxed(m)).toBe(true);
		expect(kindLabel(m)).toBe("loop");
	});

	test("parses a composition (all routine steps)", () => {
		const m = parse(COMP);
		expect(isComposition(m)).toBe(true);
		expect(isSandboxed(m)).toBe(false);
		expect(kindLabel(m)).toBe("composition");
		expect(m.steps.map((s) => s.id)).toEqual(["grill", "impl"]);
	});

	test("a read-write participant alone makes a routine sandboxed", () => {
		const m = parse({
			id: "edit",
			participants: { w: { agent: "claude", instructions: "Edit.", filesystem: "read-write" } },
			steps: [{ id: "go", call: "w", prompt: "do it" }],
		});
		expect(isSandboxed(m)).toBe(true);
		expect(kindLabel(m)).toBe("sandboxed");
	});
});

describe("parseManifest -- rules", () => {
	test("rule 1: rejects mixing routine steps with call/check", () => {
		const steps = [
			{ id: "a", call: "griller", prompt: "p" },
			{ id: "b", routine: "other", inputs: {} },
		];
		expect(() => parse({ ...TEXT, steps, output: "a" })).toThrow(/either all `routine` steps .* or call\/format\/check/);
	});

	test("rule 2: repeat with checks-pass requires a check step", () => {
		const steps = [{ id: "build", call: "builder", prompt: "p" }];
		expect(() => parse({ ...LOOP, steps })).toThrow(/requires at least one `check` step/);
	});

	test("rule 2: repeat is not valid on a composition", () => {
		expect(() => parse({ ...COMP, repeat: { until: "checks-pass" } })).toThrow(/`repeat` is not valid on a composition/);
	});

	test("rule 3: output cannot name a check step", () => {
		expect(() => parse({ ...LOOP, output: "verify" })).toThrow(/`output` cannot name a `check` step/);
	});

	test("rule 3: output must name an existing step", () => {
		expect(() => parse({ ...TEXT, output: "nope" })).toThrow(/`output` must name one of the steps/);
	});

	test("a call step must reference a participant", () => {
		const steps = [{ id: "x", call: "ghost", prompt: "p" }];
		expect(() => parse({ ...TEXT, steps, output: "x" })).toThrow(/`call` must name a participant/);
	});

	test("rejects duplicate step ids", () => {
		const steps = [
			{ id: "dup", call: "griller", prompt: "a" },
			{ id: "dup", format: "b" },
		];
		expect(() => parse({ ...TEXT, steps, output: "dup" })).toThrow(/duplicate step id/);
	});

	test("rejects a step that is more than one kind", () => {
		const steps = [{ id: "x", call: "griller", prompt: "p", format: "f" }];
		expect(() => parse({ ...TEXT, steps, output: "x" })).toThrow(/exactly one of `call`, `format`, `check`, `routine`, or `ask`/);
	});

	test("rejects an unknown filesystem permission", () => {
		const participants = { griller: { agent: "claude", instructions: "x", filesystem: "root" } };
		expect(() => parse({ ...TEXT, participants })).toThrow(/`filesystem` must be one of/);
	});

	test("rejects a non-positive repeat maxIterations", () => {
		expect(() => parse({ ...LOOP, repeat: { until: "checks-pass", maxIterations: 0 } })).toThrow(/positive integer/);
	});

	test("errors are ManifestError carrying the source", () => {
		try {
			parse({ id: "x", steps: "nope" });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ManifestError);
			expect((e as ManifestError).source).toBe("test.json");
		}
	});
});

describe("parseManifest -- ask (human input) steps", () => {
	// A text routine with a decision gate: grill, ask the operator, refine using the answer.
	const ASK_TEXT = {
		id: "clarify-flow",
		inputs: { idea: { type: "string" } },
		participants: { griller: { agent: "claude", instructions: "Grill.", filesystem: "read-only" } },
		steps: [
			{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
			{ id: "decide", ask: "Anything to add?\n{{ steps.grill.output }}" },
			{ id: "refine", call: "griller", prompt: "Refine with: {{ steps.decide.output }}" },
		],
		output: "refine",
	};

	test("parses an ask step in a text routine and keeps it an execution", () => {
		const m = parse(ASK_TEXT);
		expect(m.steps.map((s) => [s.id, s.kind])).toEqual([
			["grill", "call"],
			["decide", "ask"],
			["refine", "call"],
		]);
		const ask = m.steps.find((s) => s.id === "decide");
		expect(ask).toMatchObject({ kind: "ask", ask: "Anything to add?\n{{ steps.grill.output }}" });
		expect(isComposition(m)).toBe(false);
		expect(isSandboxed(m)).toBe(false);
		expect(kindLabel(m)).toBe("text");
	});

	test("an ask step may sit between routine steps without breaking composition detection", () => {
		const m = parse({
			id: "gated-flow",
			inputs: { idea: { type: "string" } },
			steps: [
				{ id: "grill", routine: "feature-griller", inputs: { idea: "{{ inputs.idea }}" } },
				{ id: "approve", ask: "Approve the plan? {{ steps.grill.output }}" },
				{ id: "impl", routine: "impl-review", inputs: { task: "{{ steps.approve.output }}" } },
			],
		});
		expect(isComposition(m)).toBe(true);
		expect(kindLabel(m)).toBe("composition");
		expect(m.steps.map((s) => s.kind)).toEqual(["routine", "ask", "routine"]);
	});

	test("requires a non-empty `ask` string", () => {
		const steps = [{ id: "q", ask: "" }];
		expect(() => parse({ ...ASK_TEXT, steps, output: undefined })).toThrow(/`ask` must be a non-empty question string/);
	});

	test("rejects an ask step in a sandboxed routine (a check step)", () => {
		const steps = [
			{ id: "build", call: "griller", prompt: "go" },
			{ id: "q", ask: "looks right?" },
			{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
		];
		expect(() => parse({ ...ASK_TEXT, steps, output: undefined })).toThrow(/`ask` step is not supported in a sandboxed or looping routine/);
	});

	test("rejects an ask step when a participant is read-write (sandboxed)", () => {
		expect(() =>
			parse({
				id: "edit-with-ask",
				participants: { w: { agent: "claude", instructions: "Edit.", filesystem: "read-write" } },
				steps: [
					{ id: "q", ask: "proceed?" },
					{ id: "go", call: "w", prompt: "do it" },
				],
			}),
		).toThrow(/`ask` step is not supported in a sandboxed or looping routine/);
	});

	test("rejects an ask step in a repeat loop (it has a check -> sandboxed)", () => {
		const steps = [
			{ id: "q", ask: "continue?" },
			{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
			{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
		];
		expect(() => parse({ ...LOOP, steps })).toThrow(/`ask` step is not supported in a sandboxed or looping routine/);
	});

	test("rejects `output` naming an ask step (its answer is not persisted)", () => {
		expect(() => parse({ ...ASK_TEXT, output: "decide" })).toThrow(/`output` cannot name an `ask` step/);
	});

	test("still rejects a genuine routine/execution mix (ask is neutral, not a loophole)", () => {
		const steps = [
			{ id: "r", routine: "feature-griller", inputs: {} },
			{ id: "c", call: "griller", prompt: "p" },
		];
		expect(() => parse({ ...ASK_TEXT, steps, output: undefined })).toThrow(/not a mix/);
	});
});

describe("parseManifest -- limits", () => {
	test("parses numeric per-call and per-run limits", () => {
		const m = parse({ ...TEXT, limits: { callTimeoutMinutes: 10, runTimeoutMinutes: 60 } });
		expect(m.limits).toEqual({ callTimeoutMinutes: 10, runTimeoutMinutes: 60 });
	});

	test('accepts "none" to opt a bound out entirely', () => {
		const m = parse({ ...TEXT, limits: { callTimeoutMinutes: "none" } });
		expect(m.limits).toEqual({ callTimeoutMinutes: "none" });
	});

	test("rejects an unknown limits field", () => {
		expect(() => parse({ ...TEXT, limits: { wallMinutes: 5 } })).toThrow(/unknown field "wallMinutes"/);
	});

	test("rejects a non-positive timeout", () => {
		expect(() => parse({ ...TEXT, limits: { callTimeoutMinutes: 0 } })).toThrow(/positive number of minutes or "none"/);
	});

	test('rejects a string timeout that is not "none"', () => {
		expect(() => parse({ ...TEXT, limits: { runTimeoutMinutes: "lots" } })).toThrow(/positive number of minutes or "none"/);
	});

	test("rejects callTimeoutMinutes on a composition (it makes no direct calls)", () => {
		expect(() => parse({ ...COMP, limits: { callTimeoutMinutes: 30 } })).toThrow(/not valid on a composition/);
	});

	test("allows runTimeoutMinutes on a composition (the whole-flow budget)", () => {
		const m = parse({ ...COMP, limits: { runTimeoutMinutes: 90 } });
		expect(m.limits).toEqual({ runTimeoutMinutes: 90 });
		expect(effectiveRunTimeoutMs(m)).toBe(90 * 60_000);
	});
});

describe("effective timeouts", () => {
	test("fall back to the built-in defaults when no limits are set", () => {
		const m = parse(TEXT);
		expect(effectiveCallTimeoutMs(m)).toBe(30 * 60_000);
		expect(effectiveRunTimeoutMs(m)).toBe(120 * 60_000);
	});

	test("numeric limits override the defaults", () => {
		const m = parse({ ...TEXT, limits: { callTimeoutMinutes: 5, runTimeoutMinutes: 45 } });
		expect(effectiveCallTimeoutMs(m)).toBe(5 * 60_000);
		expect(effectiveRunTimeoutMs(m)).toBe(45 * 60_000);
	});

	test('"none" disables a bound (undefined, i.e. unbounded)', () => {
		const m = parse({ ...TEXT, limits: { callTimeoutMinutes: "none", runTimeoutMinutes: "none" } });
		expect(effectiveCallTimeoutMs(m)).toBeUndefined();
		expect(effectiveRunTimeoutMs(m)).toBeUndefined();
	});
});

describe("parseManifest -- generic repeat.until", () => {
	// A /goal-style loop authored by the user: a worker call + an evaluator call whose output
	// decides convergence. No check step; the evaluator's "yes" ends the loop.
	const GOAL = {
		id: "goal-loop",
		inputs: { goal: { type: "string" } },
		participants: {
			worker: { agent: "claude", instructions: "Work toward the goal.", filesystem: "read-only" },
			evaluator: { agent: "claude", instructions: "Judge whether the goal is met.", filesystem: "read-only" },
		},
		steps: [
			{ id: "work", call: "worker", prompt: "Goal: {{ inputs.goal }}\nPrior verdict: {{ steps.done.output }}" },
			{ id: "done", call: "evaluator", prompt: "Goal: {{ inputs.goal }}\nResult: {{ steps.work.output }}\nReturn exactly yes or no." },
		],
		repeat: { until: { step: "done", equals: "yes" }, maxIterations: 8 },
	};

	test("parses a { step, equals } condition and keeps checks-pass working", () => {
		const m = parse(GOAL);
		expect(m.repeat).toEqual({ until: { step: "done", equals: "yes" }, maxIterations: 8 });
		expect(kindLabel(m)).toBe("loop");
		// no check step + read-only participants -> a NON-sandboxed loop (runs in cwd, not a worktree)
		expect(hasChecks(m)).toBe(false);
		expect(isSandboxed(m)).toBe(false);
	});

	test("a { step, equals } loop that writes is still sandboxed (loop and sandbox are independent)", () => {
		const m = parse({
			...GOAL,
			participants: {
				worker: { agent: "claude", instructions: "Edit toward the goal.", filesystem: "read-write" },
				evaluator: { agent: "claude", instructions: "Judge.", filesystem: "read-only" },
			},
		});
		expect(isSandboxed(m)).toBe(true); // a read-write participant -> worktree
		expect(kindLabel(m)).toBe("loop");
	});

	test("requires an explicit maxIterations for the { step, equals } form", () => {
		expect(() => parse({ ...GOAL, repeat: { until: { step: "done", equals: "yes" } } })).toThrow(/requires an explicit `maxIterations`/);
	});

	test("rejects a { step, equals } that names a non-existent step", () => {
		expect(() => parse({ ...GOAL, repeat: { until: { step: "ghost", equals: "yes" }, maxIterations: 3 } })).toThrow(/references "ghost", which is not a step/);
	});

	test("rejects a non-string equals", () => {
		expect(() => parse({ ...GOAL, repeat: { until: { step: "done", equals: 1 }, maxIterations: 3 } })).toThrow(/`equals` must be a string/);
	});

	test("rejects an unknown until form", () => {
		expect(() => parse({ ...GOAL, repeat: { until: "goal-met", maxIterations: 3 } })).toThrow(/`until` must be "checks-pass" or an object/);
	});

	test("rejects an ask step in a non-sandboxed repeat loop (ask still excluded from loops)", () => {
		const steps = [
			{ id: "draft", call: "worker", prompt: "{{ inputs.goal }}" },
			{ id: "gate", ask: "good enough?" },
			{ id: "done", call: "evaluator", prompt: "yes or no?" },
		];
		expect(() => parse({ ...GOAL, steps })).toThrow(/`ask` step is not supported in a sandboxed or looping routine/);
	});
});
