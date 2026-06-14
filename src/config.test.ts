import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig } from "./config.ts";

const VALID = {
	routines: {
		"feature-griller": {
			manifestPath: "examples/feature-griller.json",
			description: "Question a feature idea.",
		},
		"impl-review": {
			manifestPath: "examples/impl-review.json",
			defaults: { maxIterations: 3 },
		},
	},
};

function parse(raw: unknown) {
	return parseConfig(raw, "chit.config.json");
}

describe("parseConfig", () => {
	test("parses a valid config", () => {
		const c = parse(VALID);
		expect(Object.keys(c.routines)).toEqual(["feature-griller", "impl-review"]);
		expect(c.routines["feature-griller"]?.manifestPath).toBe("examples/feature-griller.json");
		expect(c.routines["impl-review"]?.defaults?.maxIterations).toBe(3);
	});

	test("rejects an unknown top-level field", () => {
		expect(() => parse({ ...VALID, recipes: {} })).toThrow(/unknown field "recipes"/);
	});

	test("rejects a non-kebab routine id", () => {
		expect(() => parse({ routines: { Bad_Id: { manifestPath: "m.json" } } })).toThrow(/kebab-case/);
	});

	test("rejects a missing manifestPath", () => {
		expect(() => parse({ routines: { ok: { description: "x" } } })).toThrow(/`manifestPath` must be/);
	});

	test("rejects a manifestPath that escapes with ..", () => {
		expect(() => parse({ routines: { ok: { manifestPath: "../secrets.json" } } })).toThrow(/must not contain/);
	});

	test("rejects an unknown per-routine field (no inputs in config)", () => {
		expect(() => parse({ routines: { ok: { manifestPath: "m.json", inputs: {} } } })).toThrow(
			/unknown field "inputs"/,
		);
	});

	test("rejects a non-positive default maxIterations", () => {
		expect(() => parse({ routines: { ok: { manifestPath: "m.json", defaults: { maxIterations: -1 } } } })).toThrow(
			/positive integer/,
		);
	});

	test("ConfigError carries the source path", () => {
		try {
			parse({ nope: 1 });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ConfigError);
			expect((e as ConfigError).source).toBe("chit.config.json");
		}
	});
});

describe("parseConfig -- agents", () => {
	test("defaults agents to {} when absent", () => {
		expect(parse(VALID).agents).toEqual({});
	});

	test("parses an agents registry (adapter + optional model)", () => {
		const c = parse({ ...VALID, agents: { builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude" } } });
		expect(c.agents).toEqual({ builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude" } });
	});

	test("rejects a non-object agents", () => {
		expect(() => parse({ ...VALID, agents: [] })).toThrow(/`agents` must be an object/);
	});

	test("rejects an agent without an adapter", () => {
		expect(() => parse({ ...VALID, agents: { x: { model: "o1" } } })).toThrow(/`adapter` must be a non-empty string/);
	});

	test("rejects an unknown agent field", () => {
		expect(() => parse({ ...VALID, agents: { x: { adapter: "claude", temperature: 1 } } })).toThrow(/unknown field "temperature"/);
	});

	test("rejects a non-string model", () => {
		expect(() => parse({ ...VALID, agents: { x: { adapter: "claude", model: 5 } } })).toThrow(/`model` must be a string/);
	});
});
