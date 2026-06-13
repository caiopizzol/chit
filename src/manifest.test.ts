import { describe, expect, test } from "bun:test";
import { type Manifest, ManifestError, parseManifest } from "./manifest.ts";

const ONE_SHOT = {
	id: "griller",
	policy: "one-shot",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false } },
	participants: {
		griller: { agent: "claude", instructions: "Inspect read-only.", filesystem: "read-only" },
	},
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "{{ steps.grill.output }}" },
	],
	output: "out",
};

// Step-based converge: no implementer/reviewer slots. "build"/"critique" are step
// ids; "builder"/"critic" are participant names; "verify" is a check step.
const CONVERGE = {
	id: "impl-review",
	policy: "converge",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }} {{ iteration }} {{ steps.verify.output }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
	maxIterations: 3,
};

function parse(raw: unknown): Manifest {
	return parseManifest(raw, "test.json");
}

describe("parseManifest one-shot", () => {
	test("parses a valid one-shot manifest", () => {
		const m = parse(ONE_SHOT);
		expect(m.policy).toBe("one-shot");
		expect(m.inputs.idea?.required).toBe(true);
		expect(m.inputs.context?.required).toBe(false);
		if (m.policy !== "one-shot") throw new Error("narrow");
		expect(m.steps.map((s) => s.id)).toEqual(["grill", "out"]);
		expect(m.steps[0]).toMatchObject({ kind: "call", call: "griller" });
		expect(m.steps[1]).toMatchObject({ kind: "format" });
		expect(m.output).toBe("out");
	});

	test("rejects an output that names no step", () => {
		expect(() => parse({ ...ONE_SHOT, output: "nope" })).toThrow(/`output` must name one of the steps/);
	});

	test("rejects a call step referencing an unknown participant", () => {
		const steps = [{ id: "grill", call: "ghost", prompt: "x" }];
		expect(() => parse({ ...ONE_SHOT, steps, output: "grill" })).toThrow(/`call` must name a participant/);
	});

	test("rejects a check step in a one-shot routine", () => {
		const steps = [
			{ id: "grill", call: "griller", prompt: "p" },
			{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
		];
		expect(() => parse({ ...ONE_SHOT, steps, output: "grill" })).toThrow(/`check` steps are only valid in a converge/);
	});

	test("rejects duplicate step ids", () => {
		const steps = [
			{ id: "dup", call: "griller", prompt: "a" },
			{ id: "dup", format: "b" },
		];
		expect(() => parse({ ...ONE_SHOT, steps, output: "dup" })).toThrow(/duplicate step id/);
	});
});

describe("parseManifest converge (step-based)", () => {
	test("parses a valid converge manifest as ordered steps", () => {
		const m = parse(CONVERGE);
		expect(m.policy).toBe("converge");
		if (m.policy !== "converge") throw new Error("narrow");
		expect(m.steps.map((s) => [s.id, s.kind])).toEqual([
			["build", "call"],
			["critique", "call"],
			["verify", "check"],
		]);
		const verify = m.steps[2];
		if (verify?.kind !== "check") throw new Error("narrow");
		expect(verify.checks).toEqual([{ command: "bun", args: ["test"] }]);
		expect(m.maxIterations).toBe(3);
	});

	test("has no fixed implementer/reviewer slots -- they are just step/participant names", () => {
		const m = parse(CONVERGE);
		if (m.policy !== "converge") throw new Error("narrow");
		expect(Object.keys(m.participants)).toEqual(["builder", "critic"]);
		expect("loop" in m).toBe(false);
	});

	test("requires at least one check step (the convergence signal)", () => {
		const steps = [{ id: "build", call: "builder", prompt: "p" }];
		expect(() => parse({ ...CONVERGE, steps })).toThrow(/needs at least one `check` step/);
	});

	test("rejects an empty check command list", () => {
		const steps = [
			{ id: "build", call: "builder", prompt: "p" },
			{ id: "verify", check: [] },
		];
		expect(() => parse({ ...CONVERGE, steps })).toThrow(/non-empty array of commands/);
	});

	test("rejects a non-positive maxIterations", () => {
		expect(() => parse({ ...CONVERGE, maxIterations: 0 })).toThrow(/positive integer/);
	});

	test("rejects a converge manifest with a stray top-level field", () => {
		expect(() => parse({ ...CONVERGE, output: "build" })).toThrow(/unknown field "output"/);
	});
});

describe("parseManifest shared validation", () => {
	test("rejects a missing policy", () => {
		const { policy, ...rest } = ONE_SHOT;
		expect(() => parse(rest)).toThrow(/`policy` must be/);
	});

	test("rejects an unknown filesystem permission", () => {
		const participants = { griller: { agent: "claude", instructions: "x", filesystem: "root" } };
		expect(() => parse({ ...ONE_SHOT, participants })).toThrow(/`filesystem` must be one of/);
	});

	test("rejects a manifest with no participants", () => {
		expect(() => parse({ ...ONE_SHOT, participants: {} })).toThrow(/at least one participant/);
	});

	test("rejects a step that is more than one kind", () => {
		const steps = [{ id: "x", call: "griller", prompt: "p", format: "f" }];
		expect(() => parse({ ...ONE_SHOT, steps, output: "x" })).toThrow(/exactly one of `call`, `format`, or `check`/);
	});

	test("errors are ManifestError carrying the source", () => {
		try {
			parse({ id: "x", policy: "bogus" });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ManifestError);
			expect((e as ManifestError).source).toBe("test.json");
		}
	});
});
