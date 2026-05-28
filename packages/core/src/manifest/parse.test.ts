import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifest } from "./parse.ts";

// Example-driven tests live in apps/cli/src/manifest/examples.test.ts
// because the manifest fixtures live in apps/cli/examples/. @chit/core
// stays free of cross-workspace fixture dependencies.

const VALID_BASE = {
	schema: 1,
	id: "test",
	description: "test manifest",
	inputs: { q: { type: "string" } },
	participants: { a: { agent: "codex", role: "test role", session: "stateless" } },
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
		expect(m.participants.a?.permissions.filesystem).toBe("read_only");
	});

	test("declared inferred-capability is treated as no-op", () => {
		const m = parseManifest({
			schema: 1,
			id: "x",
			description: "x",
			inputs: { files: { type: "file[]" } },
			requires: { can_pass_files: true },
			participants: { a: { agent: "codex", role: "x", session: "stateless" } },
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
				participants: { a: { agent: "codex", role: "x", session: "forever" } },
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
