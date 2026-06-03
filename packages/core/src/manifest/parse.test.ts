import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifest } from "./parse.ts";

// Example-driven tests live in apps/cli/src/manifest/examples.test.ts
// because the manifest fixtures live in examples/. @chit-run/core
// stays free of cross-workspace fixture dependencies.

const VALID_BASE = {
	schema: 1,
	id: "test",
	description: "test manifest",
	inputs: { q: { type: "string" } },
	participants: { a: { agent: "codex", instructions: "test role", session: "stateless" } },
	steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
	output: "s",
};

function expectManifestError(raw: unknown, pathFragment: string, msgFragment?: string): void {
	let caught: unknown;
	try {
		parseManifest(raw);
	} catch (e) {
		caught = e;
	}
	if (!(caught instanceof ManifestError)) {
		throw new Error(
			`expected ManifestError; got ${caught === undefined ? "no error" : String(caught)}`,
		);
	}
	expect(caught.path).toContain(pathFragment);
	if (msgFragment) expect(caught.message).toContain(msgFragment);
}

describe("defaults and inference", () => {
	test("permissions.filesystem defaults to read_only", () => {
		const m = parseManifest(VALID_BASE);
		expect(m.participants.a?.permissions?.filesystem).toBe("read_only");
	});

	test("declared inferred-capability is treated as no-op", () => {
		const m = parseManifest({
			schema: 1,
			id: "x",
			description: "x",
			inputs: { files: { type: "file[]" } },
			requires: { can_pass_files: true },
			participants: { a: { agent: "codex", instructions: "x", session: "stateless" } },
			steps: { s: { call: "a", prompt: "{{ inputs.files }}" } },
			output: "s",
		});
		expect(m.declaredRequires.can_pass_files).toBe(true);
		expect(m.inferredRequires.can_pass_files).toBe(true);
		expect(m.requires.can_pass_files).toBe(true);
	});
});

describe("invalid manifests fail with useful errors", () => {
	test("not an object", () => {
		expectManifestError([], "$", "JSON object");
	});

	test("unknown top-level field", () => {
		expectManifestError({ ...VALID_BASE, extra: 1 }, "extra", "unknown top-level field");
	});

	test("missing output", () => {
		const bad: Record<string, unknown> = { ...VALID_BASE };
		delete bad.output;
		expectManifestError(bad, "output", "missing required field");
	});

	test("output references unknown step", () => {
		expectManifestError({ ...VALID_BASE, output: "nope" }, "output", 'unknown step "nope"');
	});

	test("schema must be 1", () => {
		expectManifestError({ ...VALID_BASE, schema: 2 }, "schema", "must be 1");
	});

	test("id must be kebab-case", () => {
		expectManifestError({ ...VALID_BASE, id: "Test Bad" }, "id", "kebab-case");
	});

	test("invalid input type", () => {
		expectManifestError(
			{ ...VALID_BASE, inputs: { q: { type: "number" } } },
			"inputs.q.type",
			"must be one of",
		);
	});

	test("bad session enum", () => {
		expectManifestError(
			{
				...VALID_BASE,
				participants: { a: { agent: "codex", instructions: "x", session: "forever" } },
			},
			"participants.a.session",
			"must be one of",
		);
	});

	test("requires with false value", () => {
		expectManifestError(
			{ ...VALID_BASE, requires: { can_show_markdown: false } },
			"requires.can_show_markdown",
			"must be `true`",
		);
	});

	test("call references unknown participant", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "nope", prompt: "x" } } },
			"steps.s.call",
			'unknown participant "nope"',
		);
	});

	test("unresolved input template ref", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ inputs.missing }}" } } },
			"steps.s.prompt",
			'unknown input "missing"',
		);
	});

	test("unresolved step template ref", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ steps.ghost.output }}" } } },
			"steps.s.prompt",
			'unknown step "ghost"',
		);
	});

	test("self-referencing step", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ steps.s.output }}" } } },
			"steps.s.prompt",
			"references its own output",
		);
	});

	test("cyclic dependency between two call steps", () => {
		expectManifestError(
			{
				...VALID_BASE,
				steps: {
					stepA: { call: "a", prompt: "{{ steps.stepB.output }}" },
					stepB: { call: "a", prompt: "{{ steps.stepA.output }}" },
				},
				output: "stepA",
			},
			"steps",
			"cyclic dependency",
		);
	});

	test("step with both call and format", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", format: "x" } } },
			"steps.s",
			"`call` or `format`",
		);
	});

	test("step with neither call nor format", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { prompt: "x" } } },
			"steps.s",
			"`call` or `format`",
		);
	});

	test("call step missing prompt", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a" } } },
			"steps.s",
			"missing `prompt`",
		);
	});

	test("invalid template reference shape", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ foo.bar }}" } } },
			"steps.s.prompt",
			"invalid template reference",
		);
	});

	test("malformed template tag with pipe filter", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ inputs.q | trim }}" } } },
			"steps.s.prompt",
			"malformed template tag",
		);
	});

	test("unclosed template tag", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{ inputs.q" } } },
			"steps.s.prompt",
			"malformed template tag",
		);
	});

	test("stray closing braces", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "inputs.q }}" } } },
			"steps.s.prompt",
			'stray "}}"',
		);
	});

	test("empty template tag", () => {
		expectManifestError(
			{ ...VALID_BASE, steps: { s: { call: "a", prompt: "{{}}" } } },
			"steps.s.prompt",
			"malformed template tag",
		);
	});
});

describe("reserved ids (prototype-pollution guard)", () => {
	// Built via JSON.parse, not object literals: a literal `{ __proto__: ... }`
	// sets the prototype rather than an own key, while JSON.parse creates a real
	// own "__proto__" key — exactly the pollution vector being guarded.
	test("rejects __proto__ as a step id", () => {
		const raw = JSON.parse(
			'{"schema":1,"id":"x","description":"d","inputs":{"q":{"type":"string"}},"participants":{"a":{"agent":"codex","instructions":"r","session":"stateless"}},"steps":{"__proto__":{"call":"a","prompt":"{{ inputs.q }}"}},"output":"__proto__"}',
		);
		expectManifestError(raw, "steps.__proto__", "reserved");
	});

	test("rejects constructor as a participant id", () => {
		const raw = JSON.parse(
			'{"schema":1,"id":"x","description":"d","inputs":{"q":{"type":"string"}},"participants":{"constructor":{"agent":"codex","instructions":"r","session":"stateless"}},"steps":{"s":{"call":"constructor","prompt":"{{ inputs.q }}"}},"output":"s"}',
		);
		expectManifestError(raw, "participants.constructor", "reserved");
	});

	test("rejects prototype as an input name", () => {
		const raw = JSON.parse(
			'{"schema":1,"id":"x","description":"d","inputs":{"prototype":{"type":"string"}},"participants":{"a":{"agent":"codex","instructions":"r","session":"stateless"}},"steps":{"s":{"call":"a","prompt":"{{ inputs.prototype }}"}},"output":"s"}',
		);
		expectManifestError(raw, "inputs.prototype", "reserved");
	});
});

describe("execution policy", () => {
	// A manifest with two call steps + a format step, so loop policies have real
	// implement/review steps to reference.
	const LOOP_BASE = {
		schema: 1,
		id: "loopish",
		description: "loop-shaped manifest",
		inputs: { task: { type: "string" } },
		participants: {
			impl: { agent: "claude", instructions: "implement", session: "per_scope" },
			rev: { agent: "codex", instructions: "review", session: "per_scope" },
		},
		steps: {
			implement: { call: "impl", prompt: "{{ inputs.task }}" },
			review: { call: "rev", prompt: "{{ steps.implement.output }}" },
			out: { format: "{{ steps.review.output }}" },
		},
		output: "out",
	};

	test("absent policy normalizes to one-shot (never undefined)", () => {
		const m = parseManifest(VALID_BASE);
		expect(m.policy).toEqual({ kind: "one-shot" });
	});

	test("explicit one-shot policy", () => {
		const m = parseManifest({ ...VALID_BASE, policy: { kind: "one-shot" } });
		expect(m.policy).toEqual({ kind: "one-shot" });
	});

	test("valid loop policy normalizes with its step ids and budget", () => {
		const m = parseManifest({
			...LOOP_BASE,
			policy: { kind: "loop", implementStep: "implement", reviewStep: "review", maxIterations: 5 },
		});
		expect(m.policy).toEqual({
			kind: "loop",
			implementStep: "implement",
			reviewStep: "review",
			maxIterations: 5,
		});
	});

	test("loop policy without maxIterations omits the field (driver default applies)", () => {
		const m = parseManifest({
			...LOOP_BASE,
			policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
		});
		expect(m.policy).toEqual({ kind: "loop", implementStep: "implement", reviewStep: "review" });
	});

	test("loop policy accepts non-default step names (not hardwired to implement/review)", () => {
		const m = parseManifest({
			...LOOP_BASE,
			steps: {
				build: { call: "impl", prompt: "{{ inputs.task }}" },
				check: { call: "rev", prompt: "{{ steps.build.output }}" },
				out: { format: "{{ steps.check.output }}" },
			},
			policy: { kind: "loop", implementStep: "build", reviewStep: "check" },
		});
		expect(m.policy).toMatchObject({ implementStep: "build", reviewStep: "check" });
	});

	test("rejects unknown policy kind", () => {
		expectManifestError({ ...VALID_BASE, policy: { kind: "fanout" } }, "policy.kind");
	});

	test("rejects extra field on one-shot policy", () => {
		expectManifestError(
			{ ...VALID_BASE, policy: { kind: "one-shot", implementStep: "s" } },
			"policy.implementStep",
		);
	});

	test("rejects loop policy referencing an unknown step", () => {
		expectManifestError(
			{ ...LOOP_BASE, policy: { kind: "loop", implementStep: "nope", reviewStep: "review" } },
			"policy.implementStep",
			"unknown step",
		);
	});

	test("rejects loop policy whose step is a format (non-call) step", () => {
		expectManifestError(
			{ ...LOOP_BASE, policy: { kind: "loop", implementStep: "implement", reviewStep: "out" } },
			"policy.reviewStep",
			"call step",
		);
	});

	test("rejects loop policy with an unknown field", () => {
		expectManifestError(
			{
				...LOOP_BASE,
				policy: { kind: "loop", implementStep: "implement", reviewStep: "review", verdict: "x" },
			},
			"policy.verdict",
		);
	});

	test("rejects a non-object policy (null, array, string)", () => {
		for (const bad of [null, [], "loop"]) {
			expectManifestError({ ...VALID_BASE, policy: bad }, "policy", "must be an object");
		}
	});

	test("rejects a policy with no kind, or a non-string kind", () => {
		expectManifestError({ ...VALID_BASE, policy: {} }, "policy.kind");
		expectManifestError({ ...VALID_BASE, policy: { kind: 1 } }, "policy.kind");
	});

	test("rejects a loop policy missing implementStep or reviewStep", () => {
		expectManifestError(
			{ ...LOOP_BASE, policy: { kind: "loop", reviewStep: "review" } },
			"policy.implementStep",
		);
		expectManifestError(
			{ ...LOOP_BASE, policy: { kind: "loop", implementStep: "implement" } },
			"policy.reviewStep",
		);
	});

	test("rejects non-integer / < 1 / non-number maxIterations", () => {
		for (const bad of [0, -1, 1.5, "3", null]) {
			expectManifestError(
				{
					...LOOP_BASE,
					policy: {
						kind: "loop",
						implementStep: "implement",
						reviewStep: "review",
						maxIterations: bad,
					},
				},
				"policy.maxIterations",
			);
		}
	});
});

describe("participant role references", () => {
	// VALID_BASE's participant `a` is inline. A role reference instead names a config
	// role and may omit the fields the role supplies. parse validates shape only (it
	// has no role library); resolveManifest is what proves a reference complete.
	test("a bare role reference parses with no inline fields", () => {
		const m = parseManifest({ ...VALID_BASE, participants: { a: { role: "reviewer" } } });
		expect(m.participants.a?.role).toBe("reviewer");
		expect(m.participants.a?.agent).toBeUndefined();
		expect(m.participants.a?.instructions).toBeUndefined();
		expect(m.participants.a?.session).toBeUndefined();
	});

	test("a role reference omitting permissions leaves them undefined (the role supplies them)", () => {
		const m = parseManifest({ ...VALID_BASE, participants: { a: { role: "reviewer" } } });
		// Load-bearing: parse must NOT default a role ref's permissions to read_only,
		// or it would clobber the role's own permissions at resolution. Contrast with
		// an inline participant, which keeps the read_only default (asserted above).
		expect(m.participants.a?.permissions).toBeUndefined();
	});

	test("a role reference may shallow-override individual fields", () => {
		const m = parseManifest({
			...VALID_BASE,
			participants: { a: { role: "reviewer", agent: "codex", session: "per_scope" } },
		});
		expect(m.participants.a?.role).toBe("reviewer");
		expect(m.participants.a?.agent).toBe("codex");
		expect(m.participants.a?.session).toBe("per_scope");
		expect(m.participants.a?.instructions).toBeUndefined();
	});

	test("an inline participant (no role) still requires agent/instructions/session", () => {
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { instructions: "x", session: "stateless" } } },
			"participants.a",
			"missing `agent`",
		);
	});

	test("rejects a non-kebab-case role reference", () => {
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { role: "Reviewer One" } } },
			"participants.a.role",
			"kebab-case",
		);
	});

	test("rejects an empty or non-string role reference", () => {
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { role: "" } } },
			"participants.a.role",
			"non-empty string",
		);
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { role: 123 } } },
			"participants.a.role",
			"non-empty string",
		);
	});

	test("validates override fields on a role reference (bad session enum)", () => {
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { role: "reviewer", session: "forever" } } },
			"participants.a.session",
			"must be one of",
		);
	});

	test("still rejects unknown participant fields alongside a role reference", () => {
		expectManifestError(
			{ ...VALID_BASE, participants: { a: { role: "reviewer", bogus: 1 } } },
			"participants.a",
			'unknown field "bogus"',
		);
	});
});
