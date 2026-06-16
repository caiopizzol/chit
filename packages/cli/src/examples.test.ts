import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { isSandboxed, kindLabel } from "./manifest.ts";
import { resolveRoutine } from "./routine.ts";

const PUBLIC_EXAMPLES = ["fix", "goal", "implement", "investigate", "plan", "review"] as const;

describe("public examples", () => {
	test("keeps the examples folder focused on copyable starter routines", () => {
		const files = readdirSync(join(process.cwd(), "examples"))
			.filter((name) => name.endsWith(".json"))
			.sort();
		expect(files).toEqual(PUBLIC_EXAMPLES.map((name) => `${name}.json`).sort());
	});

	test("each public example resolves from the package config", () => {
		const config = loadConfig(process.cwd());
		for (const id of PUBLIC_EXAMPLES) {
			const routine = resolveRoutine(config, id, process.cwd());
			expect(routine.manifest.id).toBe(id);
			expect(routine.digest).toStartWith("sha256:");
		}
	});

	test("examples cover the intended customer workflows", () => {
		const config = loadConfig(process.cwd());
		const plan = resolveRoutine(config, "plan", process.cwd()).manifest;
		const investigate = resolveRoutine(config, "investigate", process.cwd()).manifest;
		const implement = resolveRoutine(config, "implement", process.cwd()).manifest;
		const fix = resolveRoutine(config, "fix", process.cwd()).manifest;
		const review = resolveRoutine(config, "review", process.cwd()).manifest;
		const goal = resolveRoutine(config, "goal", process.cwd()).manifest;

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
