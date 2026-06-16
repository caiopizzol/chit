import { describe, expect, test } from "bun:test";
import { evaluateStructured, type JsonSchema, parseJsonSchema, readPath, validateJson } from "./structured.ts";

// parseJsonSchema takes an injected thrower so it never imports the manifest; tests use a
// plain Error that carries "<where>: <detail>" so assertions can match the message.
const parse = (raw: unknown): JsonSchema =>
	parseJsonSchema(raw, "schema", (where, detail) => {
		throw new Error(`${where}: ${detail}`);
	});

const VERDICT: JsonSchema = parse({
	type: "object",
	additionalProperties: false,
	required: ["passed", "missing", "next"],
	properties: {
		passed: { type: "boolean" },
		missing: { type: "array", items: { type: "string" } },
		next: { type: "string" },
	},
});

describe("parseJsonSchema", () => {
	test("accepts the reviewer's verdict schema", () => {
		expect(VERDICT.type).toBe("object");
		expect(VERDICT.required).toEqual(["passed", "missing", "next"]);
		expect(VERDICT.properties?.missing?.items?.type).toBe("string");
	});

	test("accepts enum on a scalar", () => {
		expect(parse({ type: "string", enum: ["ship", "revise"] }).enum).toEqual(["ship", "revise"]);
	});

	test("rejects an unsupported keyword (no silent under-validation)", () => {
		expect(() => parse({ type: "string", minLength: 3 })).toThrow(/unsupported schema keyword "minLength"/);
	});

	test("rejects a missing or unknown type", () => {
		expect(() => parse({})).toThrow(/`type` must be one of/);
		expect(() => parse({ type: "null" })).toThrow(/`type` must be one of/);
	});

	test("rejects enum on a non-scalar, object keys on a non-object, items on a non-array", () => {
		expect(() => parse({ type: "object", enum: [1] })).toThrow(/`enum` is only supported on a string\/number\/integer\/boolean/);
		expect(() => parse({ type: "string", properties: {} })).toThrow(/only valid on an `object` schema/);
		expect(() => parse({ type: "string", items: { type: "string" } })).toThrow(/`items` is only valid on an `array` schema/);
	});

	test("rejects a required name that is not declared in properties (catches typos)", () => {
		expect(() => parse({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })).toThrow(/"b" is not declared in `properties`/);
	});

	test("reports the nested path on a bad sub-schema", () => {
		expect(() => parse({ type: "object", properties: { a: { type: "nope" } } })).toThrow(/schema\.properties\.a: `type` must be one of/);
	});
});

describe("validateJson", () => {
	test("passes a conforming value", () => {
		expect(validateJson({ passed: true, missing: [], next: "go" }, VERDICT)).toEqual([]);
		expect(validateJson({ passed: false, missing: ["x", "y"], next: "fix" }, VERDICT)).toEqual([]);
	});

	test("reports a missing required property", () => {
		expect(validateJson({ missing: [], next: "go" }, VERDICT)).toEqual(['$: missing required property "passed"']);
	});

	test("reports a type mismatch with the path", () => {
		expect(validateJson({ passed: "yes", missing: [], next: "go" }, VERDICT)).toEqual(["$.passed: expected boolean, got string"]);
	});

	test("reports an unexpected property under additionalProperties:false", () => {
		expect(validateJson({ passed: true, missing: [], next: "go", extra: 1 }, VERDICT)).toEqual(['$: unexpected property "extra"']);
	});

	test("validates array items", () => {
		expect(validateJson({ passed: true, missing: ["ok", 2], next: "go" }, VERDICT)).toEqual(["$.missing[1]: expected string, got number"]);
	});

	test("enum membership", () => {
		const s = parse({ type: "string", enum: ["ship", "revise"] });
		expect(validateJson("ship", s)).toEqual([]);
		expect(validateJson("maybe", s)).toEqual(['$: "maybe" is not one of: "ship", "revise"']);
	});

	test("integer is stricter than number; null is not a type match", () => {
		expect(validateJson(1.5, parse({ type: "integer" }))).toEqual(["$: expected integer, got number"]);
		expect(validateJson(3, parse({ type: "integer" }))).toEqual([]);
		expect(validateJson(null, parse({ type: "boolean" }))).toEqual(["$: expected boolean, got null"]);
	});
});

describe("evaluateStructured", () => {
	test("valid bare JSON normalizes and exposes the parsed value", () => {
		const r = evaluateStructured('{"passed":true,"missing":[],"next":"go"}', VERDICT);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toEqual({ passed: true, missing: [], next: "go" });
			expect(r.normalized).toBe('{\n  "passed": true,\n  "missing": [],\n  "next": "go"\n}');
		}
	});

	test("unwraps a ```json fence", () => {
		const r = evaluateStructured('```json\n{"passed":false,"missing":["a"],"next":"x"}\n```', VERDICT);
		expect(r.ok).toBe(true);
	});

	test("non-JSON output becomes a useful error", () => {
		const r = evaluateStructured("ship it, looks good", VERDICT);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/output is not valid JSON/);
	});

	test("schema-invalid output lists what to fix", () => {
		const r = evaluateStructured('{"passed":"nope"}', VERDICT);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/did not match the declared schema/);
			expect(r.error).toMatch(/missing required property "missing"/);
			expect(r.error).toMatch(/\$\.passed: expected boolean, got string/);
		}
	});
});

describe("readPath", () => {
	test("reads top-level and nested keys", () => {
		expect(readPath({ passed: true }, "passed")).toBe(true);
		expect(readPath({ decision: { ready: false } }, "decision.ready")).toBe(false);
	});

	test("returns undefined for a missing segment or a non-object traversal", () => {
		expect(readPath({ a: 1 }, "b")).toBeUndefined();
		expect(readPath({ a: 1 }, "a.b")).toBeUndefined();
		expect(readPath(undefined, "a")).toBeUndefined();
		expect(readPath({ list: [1, 2] }, "list.0")).toBeUndefined();
	});
});
