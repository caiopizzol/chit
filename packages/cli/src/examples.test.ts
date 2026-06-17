import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { isSandboxed, kindLabel } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";

const PUBLIC_EXAMPLES = ["fix", "goal", "implement", "investigate", "plan", "review"] as const;
const PACKAGE_ROOT = join(import.meta.dir, "..");

function exampleConfig() {
	return parseConfig(
		JSON.parse(readFileSync(join(PACKAGE_ROOT, "examples/chit.config.json"), "utf-8")),
		"examples/chit.config.json",
	);
}

describe("public examples", () => {
	test("keeps the examples folder focused on copyable config and routines", () => {
		const files = readdirSync(join(PACKAGE_ROOT, "examples"))
			.filter((name) => name.endsWith(".json"))
			.sort();
		expect(files).toEqual(["chit.config.json", ...PUBLIC_EXAMPLES.map((name) => `${name}.json`)].sort());
	});

	test("each public example resolves from the config example", () => {
		const config = exampleConfig();
		for (const id of PUBLIC_EXAMPLES) {
			const routine = resolveRoutine(config, id, PACKAGE_ROOT);
			expect(routine.manifest.id).toBe(id);
			expect(routine.digest).toStartWith("sha256:");
		}
	});

	test("examples cover the intended customer workflows", () => {
		const config = exampleConfig();
		const plan = resolveRoutine(config, "plan", PACKAGE_ROOT).manifest;
		const investigate = resolveRoutine(config, "investigate", PACKAGE_ROOT).manifest;
		const implement = resolveRoutine(config, "implement", PACKAGE_ROOT).manifest;
		const fix = resolveRoutine(config, "fix", PACKAGE_ROOT).manifest;
		const review = resolveRoutine(config, "review", PACKAGE_ROOT).manifest;
		const goal = resolveRoutine(config, "goal", PACKAGE_ROOT).manifest;

		expect(kindLabel(plan)).toBe("text");
		expect(kindLabel(investigate)).toBe("text");
		expect(kindLabel(review)).toBe("text");
		expect(kindLabel(goal)).toBe("loop");
		expect(isSandboxed(goal)).toBe(false);
		for (const routine of [implement, fix]) {
			expect(kindLabel(routine)).toBe("loop");
			expect(isSandboxed(routine)).toBe(true);
			expect(routine.repeat?.until).toEqual({
				all: ["checks-pass", { step: "review", path: "passed", equals: true }],
			});
		}
	});
});
