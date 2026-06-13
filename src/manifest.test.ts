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

const CONVERGE = {
	id: "impl-review",
	policy: "converge",
	inputs: { task: { type: "string" } },
	participants: {
		impl: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		rev: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	loop: { implementer: "impl", reviewer: "rev" },
	checks: [{ command: "bun", args: ["test"] }],
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
		expect(m.participants.griller?.filesystem).toBe("read-only");
		if (m.policy !== "one-shot") throw new Error("narrow");
		expect(m.steps.map((s) => s.id)).toEqual(["grill", "out"]);
		expect(m.steps[0]).toMatchObject({ kind: "call", call: "griller" });
		expect(m.steps[1]).toMatchObject({ kind: "format" });
		expect(m.output).toBe("out");
	});

	test("required defaults to true when omitted", () => {
		expect(parse(ONE_SHOT).inputs.idea?.required).toBe(true);
	});

	test("rejects an output that names no step", () => {
		expect(() => parse({ ...ONE_SHOT, output: "nope" })).toThrow(/`output` must name one of the steps/);
	});

	test("rejects a call step referencing an unknown participant", () => {
		const steps = [{ id: "grill", call: "ghost", prompt: "x" }];
		expect(() => parse({ ...ONE_SHOT, steps, output: "grill" })).toThrow(/`call` must name a participant/);
	});

	test("rejects a step that is both call and format", () => {
		const steps = [{ id: "x", call: "griller", prompt: "p", format: "f" }];
		expect(() => parse({ ...ONE_SHOT, steps, output: "x" })).toThrow(/exactly one of `call` or `format`/);
	});

	test("rejects duplicate step ids", () => {
		const steps = [
			{ id: "dup", call: "griller", prompt: "a" },
			{ id: "dup", format: "b" },
		];
		expect(() => parse({ ...ONE_SHOT, steps, output: "dup" })).toThrow(/duplicate step id/);
	});

	test("rejects converge-only fields on a one-shot manifest", () => {
		expect(() => parse({ ...ONE_SHOT, checks: [] })).toThrow(/unknown field "checks"/);
	});
});

describe("parseManifest converge", () => {
	test("parses a valid converge manifest", () => {
		const m = parse(CONVERGE);
		expect(m.policy).toBe("converge");
		if (m.policy !== "converge") throw new Error("narrow");
		expect(m.loop).toEqual({ implementer: "impl", reviewer: "rev" });
		expect(m.checks).toEqual([{ command: "bun", args: ["test"] }]);
		expect(m.maxIterations).toBe(3);
	});

	test("loop roles are references to participants, not fixed names", () => {
		const m = parse({ ...CONVERGE, loop: { implementer: "rev", reviewer: "impl" } });
		if (m.policy !== "converge") throw new Error("narrow");
		expect(m.loop.implementer).toBe("rev");
	});

	test("rejects a loop role naming no participant", () => {
		expect(() => parse({ ...CONVERGE, loop: { implementer: "impl", reviewer: "ghost" } })).toThrow(
			/`reviewer` must name a participant/,
		);
	});

	test("rejects one-shot-only fields on a converge manifest", () => {
		expect(() => parse({ ...CONVERGE, steps: [] })).toThrow(/unknown field "steps"/);
	});

	test("rejects a non-positive maxIterations", () => {
		expect(() => parse({ ...CONVERGE, maxIterations: 0 })).toThrow(/positive integer/);
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
