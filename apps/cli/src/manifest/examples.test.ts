// Integration tests for parseManifest against the example manifests that
// live in examples/. parseManifest itself lives in @chit-run/core;
// this test exercises it against real fixtures.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "@chit-run/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "..", "examples");

function loadExample(name: string): unknown {
	return JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), "utf8"));
}

describe("example manifests", () => {
	test("ships only the curated public examples", () => {
		expect(
			readdirSync(EXAMPLES)
				.filter((file) => file.endsWith(".json"))
				.sort(),
		).toEqual(["consult.json", "converge.json"]);
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

	test("converge normalizes to implement, review, then format", () => {
		const m = parseManifest(loadExample("converge"));

		expect(m.id).toBe("converge");
		expect(m.output).toBe("out");

		expect(m.inputs.task?.type).toBe("string");
		expect(m.inputs.prior_review?.optional).toBe(true);
		expect(m.participants.implementer?.permissions.filesystem).toBe("write");
		expect(m.participants.reviewer?.permissions.filesystem).toBe("read_only");
		expect(m.inferredRequires.can_provide_stable_scope).toBe(true);

		expect(m.executionOrder).toEqual([["implement"], ["review"], ["out"]]);
		expect(m.dependencies.implement).toEqual([]);
		expect(m.dependencies.review).toEqual(["implement"]);
		expect(m.dependencies.out).toEqual(["implement", "review"]);
	});
});
