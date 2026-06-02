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
		).toEqual(["consult.json", "converge-codex-writer.json", "converge.json"]);
	});

	test("consult normalizes to parallel fan-out", () => {
		const m = parseManifest(loadExample("consult"));

		expect(m.id).toBe("consult");
		expect(m.executionOrder.length).toBe(2);
		expect([...(m.executionOrder[0] as string[])].sort()).toEqual(["ask_claude", "ask_codex"]);
		expect(m.executionOrder[1]).toEqual(["out"]);

		expect(m.inferredRequires.can_pass_files).toBeUndefined();
		expect(m.inferredRequires.can_provide_stable_scope).toBe(true);

		// No declared policy -> normalizes to one-shot (a single DAG pass).
		expect(m.policy).toEqual({ kind: "one-shot" });
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

		// Declares the loop execution policy naming its implement/review steps.
		expect(m.policy).toEqual({
			kind: "loop",
			implementStep: "implement",
			reviewStep: "review",
		});
	});

	test("converge-codex-writer swaps the agents but keeps the permission roles", () => {
		const m = parseManifest(loadExample("converge-codex-writer"));

		expect(m.id).toBe("converge-codex-writer");
		// Same loop shape as converge.json (the loop driver keys on these step ids).
		expect(m.executionOrder).toEqual([["implement"], ["review"], ["out"]]);
		// The roles are swapped by vendor, but the permission boundary is unchanged:
		// the implementer writes, the reviewer is read-only, regardless of agent.
		expect(m.participants.implementer?.agent).toBe("codex");
		expect(m.participants.implementer?.permissions.filesystem).toBe("write");
		expect(m.participants.reviewer?.agent).toBe("claude");
		expect(m.participants.reviewer?.permissions.filesystem).toBe("read_only");
	});
});
