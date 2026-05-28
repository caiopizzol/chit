import { describe, expect, test } from "bun:test";
import { buildGraphModel, parseManifest, parseRegistry } from "@chit/core";
import { canonicalize, canSave, deepEqual, isDirty } from "./editor.ts";

const REGISTRY = parseRegistry(undefined);

function chit(id: string, description = "a chit"): string {
	return JSON.stringify({
		schema: 1,
		id,
		description,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: { a: { agent: "codex", role: "r", session: "stateless" } },
		steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
		output: "s",
	});
}

function graphFor(raw: string, surface?: "claude-skill" | "cli") {
	return buildGraphModel(parseManifest(JSON.parse(raw)), REGISTRY, surface);
}

describe("deepEqual", () => {
	test("primitives", () => {
		expect(deepEqual(1, 1)).toBe(true);
		expect(deepEqual("a", "a")).toBe(true);
		expect(deepEqual(1, 2)).toBe(false);
		expect(deepEqual(null, null)).toBe(true);
		expect(deepEqual(null, undefined)).toBe(false);
	});

	test("objects are key-order independent", () => {
		expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	test("nested + arrays", () => {
		expect(deepEqual({ a: [1, { x: 2 }] }, { a: [1, { x: 2 }] })).toBe(true);
		expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
	});

	test("object vs array of same length is not equal", () => {
		expect(deepEqual({ 0: "a" }, ["a"])).toBe(false);
	});
});

describe("canonicalize", () => {
	test("tab-indented, roundtrippable", () => {
		const obj = { schema: 1, id: "x" };
		const text = canonicalize(obj);
		expect(text).toContain("\t");
		expect(JSON.parse(text)).toEqual(obj);
	});

	test("deterministic for the same object", () => {
		const obj = { a: 1, b: { c: 2 } };
		expect(canonicalize(obj)).toBe(canonicalize(obj));
	});
});

describe("isDirty", () => {
	test("draft equal to parsed raw is not dirty even if raw formatting differs", () => {
		const draft = JSON.parse(chit("consult"));
		// raw with extra whitespace / different indentation than draft
		const raw = JSON.stringify(draft, null, 4);
		expect(isDirty(draft, raw)).toBe(false);
	});

	test("changed description is dirty", () => {
		const raw = chit("consult", "original");
		const draft = JSON.parse(raw);
		draft.description = "edited";
		expect(isDirty(draft, raw)).toBe(true);
	});

	test("unparseable raw makes any draft dirty", () => {
		expect(isDirty({ anything: true }, "not json")).toBe(true);
	});
});

describe("canSave", () => {
	const base = (raw: string, surface: "claude-skill" | "cli") => ({
		dirty: true,
		previewPending: false,
		previewError: null,
		conflict: false,
		graphModel: graphFor(raw, surface),
	});

	test("dirty + clean preview + warn validation is saveable", () => {
		// consult on claude-skill yields permissions warn (claude gap), which is
		// saveable. Use a codex-only chit so there is no gap at all = ok.
		const g = base(chit("consult"), "claude-skill");
		expect(canSave(g)).toBe(true);
	});

	test("not dirty is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), dirty: false })).toBe(false);
	});

	test("preview pending is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), previewPending: true })).toBe(false);
	});

	test("preview error is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), previewError: "boom" })).toBe(false);
	});

	test("conflict is not saveable", () => {
		expect(canSave({ ...base(chit("c"), "cli"), conflict: true })).toBe(false);
	});

	test("warn-severity validation (needs_override) is saveable", () => {
		// claude participant on claude-skill: claude-cli cannot enforce read_only
		// -> permissions needs_override -> warn severity -> still saveable.
		const warnChit = JSON.stringify({
			schema: 1,
			id: "w",
			description: "d",
			inputs: { q: { type: "string" } },
			requires: {},
			participants: { c: { agent: "claude", role: "r", session: "stateless" } },
			steps: { s: { call: "c", prompt: "{{ inputs.q }}" } },
			output: "s",
		});
		const g = base(warnChit, "claude-skill");
		expect(canSave(g)).toBe(true);
	});
});
