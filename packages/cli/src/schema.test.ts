import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { buildProfileSchema } from "./builtin-adapters.ts";
import { parseConfig } from "./config.ts";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

const schema = readJson(join(process.cwd(), "schemas/chit.schema.json")) as AnySchema;

function configPaths(): string[] {
	const paths = [join(process.cwd(), "chit.config.json")];
	const scenarios = join(process.cwd(), "test/scenarios");
	for (const dir of readdirSync(scenarios, { withFileTypes: true })) {
		if (dir.isDirectory()) paths.push(join(scenarios, dir.name, "chit.config.json"));
	}
	return paths;
}

describe("schemas/chit.schema.json", () => {
	test("validates every checked-in config file, then the parser accepts it too", () => {
		const ajv = new Ajv2020({ allErrors: true });
		const validate = ajv.compile(schema);
		for (const path of configPaths()) {
			const raw = readJson(path);
			const ok = validate(raw);
			expect(ok, `${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
			expect(() => parseConfig(raw, path)).not.toThrow();
		}
	});

	test("validates the preferred single-file authoring shape", () => {
		const ajv = new Ajv2020({ allErrors: true });
		const validate = ajv.compile(schema);
		const raw = {
			$schema: "https://chit.run/schemas/chit.schema.json",
			profiles: {
				builder: "codex:gpt-5.5",
				critic: "gemini",
			},
			routines: {
				implement: {
					input: "task",
					agents: {
						builder: {
							profile: "builder",
							instructions: "Implement the smallest correct change.",
							filesystem: "read-write",
						},
						critic: {
							profile: "critic",
							instructions: "Review the diff and return pass when approved.",
							filesystem: "read-only",
						},
					},
					steps: [
						{ id: "build", call: "builder", prompt: "Task:\n{{ inputs.task }}" },
						{ id: "review", call: "critic", prompt: "{{ diff }}" },
						{ id: "verify", check: ["bun run typecheck", "bun test"] },
					],
					repeat: {
						until: { all: ["checks-pass", { step: "review", equals: "pass" }] },
						maxIterations: 3,
					},
				},
			},
		};
		const ok = validate(raw);
		expect(ok, ajv.errorsText(validate.errors)).toBe(true);
		expect(() => parseConfig(raw, "inline.json")).not.toThrow();
	});
});

describe("profile validation: built-in adapter/model pairs (schema)", () => {
	const ajv = new Ajv2020({ allErrors: true });
	const validate = ajv.compile(schema);
	const okSchema = (profile: unknown): boolean => validate({ profiles: { x: profile }, routines: {} }) === true;

	test("the schema's profile def is generated from the adapter registry (no drift)", () => {
		expect((schema as { $defs: { profile: unknown } }).$defs.profile).toEqual(buildProfileSchema());
	});

	test("rejects impossible built-in adapter/model pairs", () => {
		expect(okSchema("codex:sonnet")).toBe(false); // sonnet is a claude model
		expect(okSchema("claude:gpt-5.5")).toBe(false); // gpt is codex
		expect(okSchema({ adapter: "codex", model: "sonnet" })).toBe(false);
		expect(okSchema("gemini:opus")).toBe(false);
	});

	test("rejects a custom adapter in shorthand (object form is required for custom)", () => {
		expect(okSchema("my-adapter:whatever")).toBe(false);
		expect(okSchema("my-adapter")).toBe(false);
	});

	test("rejects a trailing ':' with no model (lockstep with the parser)", () => {
		expect(okSchema("codex:")).toBe(false);
		expect(okSchema("claude:")).toBe(false);
		expect(okSchema("gemini:")).toBe(false);
	});

	test("accepts valid built-in pairs, custom object form, and default/omitted model", () => {
		expect(okSchema("codex:gpt-5.5")).toBe(true);
		expect(okSchema("claude:sonnet")).toBe(true);
		expect(okSchema("claude:claude-opus-4-8")).toBe(true); // full name via the prefix pattern
		expect(okSchema("gemini:gemini-3-flash")).toBe(true);
		expect(okSchema("gemini")).toBe(true);
		expect(okSchema({ adapter: "claude", model: "default", effort: "max" })).toBe(true);
		expect(okSchema({ adapter: "codex", effort: "xhigh" })).toBe(true); // omitted model
		expect(okSchema({ adapter: "my-adapter", model: "whatever", effort: "custom-depth" })).toBe(true); // custom, opaque model
	});

	test("validates adapter-specific profile options", () => {
		expect(okSchema({ adapter: "claude", effort: "max" })).toBe(true);
		expect(okSchema({ adapter: "codex", effort: "xhigh" })).toBe(true);
		expect(okSchema({ adapter: "claude", effort: "xhigh" })).toBe(false);
		expect(okSchema({ adapter: "codex", effort: "max" })).toBe(false);
		expect(okSchema({ adapter: "gemini", effort: "xhigh" })).toBe(false);
	});
});

describe("schemas/chit.schema.json -- changePolicy", () => {
	const ajv = new Ajv2020({ allErrors: true });
	const validate = ajv.compile(schema);

	const sandboxedRoutine = (changePolicy: unknown) => ({
		profiles: { builder: "claude" },
		routines: {
			impl: {
				input: "task",
				agents: {
					builder: { profile: "builder", instructions: "Build.", filesystem: "read-write" },
				},
				steps: [
					{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
					{ id: "verify", check: ["bun test"] },
				],
				repeat: { until: "checks-pass", maxIterations: 2 },
				changePolicy,
			},
		},
	});

	test("accepts allowedChangedPaths", () => {
		expect(validate(sandboxedRoutine({ allowedChangedPaths: ["src/"] }))).toBe(true);
	});

	test("accepts deniedChangedPaths", () => {
		expect(validate(sandboxedRoutine({ deniedChangedPaths: [".env"] }))).toBe(true);
	});

	test("accepts both allowed and denied together", () => {
		expect(validate(sandboxedRoutine({ allowedChangedPaths: ["src/"], deniedChangedPaths: [".env"] }))).toBe(true);
	});

	test("rejects an empty changePolicy object", () => {
		expect(validate(sandboxedRoutine({}))).toBe(false);
	});

	test("rejects unknown fields in changePolicy", () => {
		expect(validate(sandboxedRoutine({ allowedChangedPaths: ["src/"], extra: true }))).toBe(false);
	});

	test("rejects an empty allowedChangedPaths array", () => {
		expect(validate(sandboxedRoutine({ allowedChangedPaths: [] }))).toBe(false);
	});

	test("rejects a non-string entry in allowedChangedPaths", () => {
		expect(validate(sandboxedRoutine({ allowedChangedPaths: [123] }))).toBe(false);
	});
});

describe("schemas/chit.schema.json -- structured output", () => {
	const ajv = new Ajv2020({ allErrors: true });
	const validate = ajv.compile(schema);

	test("accepts a json call step and a { step, path, equals } condition (schema + parser)", () => {
		const raw = {
			$schema: "https://chit.run/schemas/chit.schema.json",
			profiles: { critic: "gemini" },
			routines: {
				goal: {
					input: "idea",
					agents: { judge: { profile: "critic", instructions: "Judge.", filesystem: "read-only" } },
					steps: [
						{
							id: "verdict",
							call: "judge",
							prompt: "{{ inputs.idea }}",
							json: {
								schema: {
									type: "object",
									required: ["ready"],
									additionalProperties: false,
									properties: { ready: { type: "boolean" } },
								},
							},
						},
					],
					repeat: { until: { step: "verdict", path: "ready", equals: true }, maxIterations: 3 },
				},
			},
		};
		expect(validate(raw), ajv.errorsText(validate.errors)).toBe(true);
		expect(() => parseConfig(raw, "inline.json")).not.toThrow();
	});
});
