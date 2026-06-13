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
