// Integration tests for parseManifest against the example manifests that
// live in apps/cli/examples/. parseManifest itself lives in @chit/core;
// this test exercises it against real fixtures.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "@chit/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples");

function loadExample(name: string): unknown {
	return JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), "utf8"));
}

describe("example manifests", () => {
	test("investigate-bug normalizes to sequential execution order", () => {
		const m = parseManifest(loadExample("investigate-bug"));

		expect(m.id).toBe("investigate-bug");
		expect(m.output).toBe("out");

		expect(m.inferredRequires.can_pass_files).toBe(true);
		expect(m.inferredRequires.can_provide_stable_scope).toBe(true);
		expect(m.declaredRequires.can_show_markdown).toBe(true);
		expect(m.requires).toEqual({
			can_show_markdown: true,
			can_pass_files: true,
			can_provide_stable_scope: true,
		});

		expect(m.participants.diagnostician.permissions.filesystem).toBe("read_only");
		expect(m.participants.verifier.permissions.filesystem).toBe("read_only");

		expect(m.executionOrder).toEqual([["diagnose"], ["verify"], ["out"]]);
		expect(m.dependencies.diagnose).toEqual([]);
		expect(m.dependencies.verify).toEqual(["diagnose"]);
		expect(m.dependencies.out).toEqual(["diagnose", "verify"]);
	});

	test("consult normalizes to parallel fan-out", () => {
		const m = parseManifest(loadExample("consult"));

		expect(m.id).toBe("consult");
		expect(m.executionOrder.length).toBe(2);
		expect([...(m.executionOrder[0] as string[])].sort()).toEqual(["ask_claude", "ask_codex"]);
		expect(m.executionOrder[1]).toEqual(["out"]);

		expect(m.inferredRequires.can_pass_files).toBeUndefined();
		expect(m.inferredRequires.can_provide_stable_scope).toBe(true);
	});
});
