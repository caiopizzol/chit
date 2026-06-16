import { describe, expect, test } from "bun:test";
import { validateInputs } from "./inputs.ts";
import type { Manifest } from "./manifest.ts";

const manifest = {
	id: "griller",
	inputs: {
		idea: { type: "string", required: true },
		context: { type: "string", required: false, description: "extra background" },
	},
	participants: { griller: { id: "griller", agent: "claude", instructions: "x", filesystem: "read-only" } },
	steps: [{ id: "out", kind: "format", format: "x" }],
	output: "out",
} as Manifest;

describe("validateInputs", () => {
	test("accepts the required input and keeps only declared values", () => {
		const r = validateInputs(manifest, { idea: "dark mode" });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("narrow");
		expect(r.values).toEqual({ idea: "dark mode" });
	});

	test("accepts an optional input when provided", () => {
		const r = validateInputs(manifest, { idea: "x", context: "y" });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("narrow");
		expect(r.values).toEqual({ idea: "x", context: "y" });
	});

	test("refuses a missing required input with a helpful message", () => {
		const r = validateInputs(manifest, { context: "y" });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("narrow");
		expect(r.errors[0]).toMatch(/missing required input "idea"/);
	});

	test("treats an empty required input as missing", () => {
		const r = validateInputs(manifest, { idea: "" });
		expect(r.ok).toBe(false);
	});

	test("refuses an unknown input and lists the declared ones", () => {
		const r = validateInputs(manifest, { idea: "x", nope: "z" });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("narrow");
		expect(r.errors[0]).toMatch(/unknown input "nope".*idea, context/);
	});

	test("collects multiple errors at once", () => {
		const r = validateInputs(manifest, { nope: "z" });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("narrow");
		expect(r.errors.length).toBe(2);
	});
});
