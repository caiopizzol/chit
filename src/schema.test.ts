import { describe, expect, test } from "bun:test";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./config.ts";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}

const schema = readJson(join(process.cwd(), "schemas/chit.schema.json")) as AnySchema;

function configPaths(): string[] {
	const paths = [join(process.cwd(), "chit.config.json")];
	const scenarios = join(process.cwd(), "scenarios");
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
			$schema: "https://chit.dev/schemas/chit.schema.json",
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
