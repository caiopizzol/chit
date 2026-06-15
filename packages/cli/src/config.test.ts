import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig } from "./config.ts";
import { resolveRoutine } from "./routine.ts";

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

const INLINE = {
	profiles: {
		builder: "codex:gpt-5.5",
		critic: { adapter: "gemini" },
	},
	routines: {
		implement: {
			input: "task",
			agents: {
				builder: {
					profile: "builder",
					instructions: "Build.",
					filesystem: "read-write",
				},
				critic: {
					profile: "critic",
					instructions: "Review.",
					filesystem: "read-only",
				},
			},
			steps: [
				{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
				{ id: "review", call: "critic", prompt: "{{ diff }}" },
				{ id: "verify", check: "bun test" },
			],
			repeat: { until: "checks-pass", maxIterations: 3 },
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
		expect(() => parse({ routines: { ok: { description: "x" } } })).toThrow(/`steps` must be an array/);
	});

	test("rejects a manifestPath that escapes with ..", () => {
		expect(() => parse({ routines: { ok: { file: "../secrets.json" } } })).toThrow(/must not contain/);
	});

	test("parses file as the friendlier alias for manifestPath", () => {
		const c = parse({ routines: { ok: { file: "m.json" } } });
		expect(c.routines.ok?.manifestPath).toBe("m.json");
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

	test("parses an inline routine from the config file", () => {
		const c = parse(INLINE);
		const r = c.routines.implement;
		expect(r?.manifestPath).toBe("chit.config.json#routines.implement");
		expect(r?.manifest?.inputs).toEqual({ task: { type: "string", required: true } });
		expect(r?.manifest?.participants.builder).toEqual({
			id: "builder",
			agent: "builder",
			instructions: "Build.",
			filesystem: "read-write",
		});
		expect(r?.manifest?.steps.at(-1)).toEqual({
			id: "verify",
			kind: "check",
			checks: [{ command: "sh", args: ["-c", "bun test"] }],
		});
	});

	test("an inline routine resolves without reading a manifest file", () => {
		const c = parse(INLINE);
		const r = resolveRoutine(c, "implement", "/tmp/project", () => {
			throw new Error("should not read");
		});
		expect(r.manifestPath).toBe("chit.config.json#routines.implement");
		expect(r.manifestAbs).toBe("/tmp/project/chit.config.json");
		expect(r.digest).toStartWith("sha256:");
		expect(r.agents).toEqual({
			builder: { adapter: "codex", model: "gpt-5.5" },
			critic: { adapter: "gemini" },
		});
	});
});

describe("parseConfig -- agents", () => {
	test("defaults agents to {} when absent", () => {
		expect(parse(VALID).agents).toEqual({});
	});

	test("parses an agents registry (adapter + optional model)", () => {
		const c = parse({
			...VALID,
			agents: {
				builder: { adapter: "claude", model: "sonnet", effort: "max" },
				critic: { adapter: "codex", model: "gpt-5.5", reasoningEffort: "xhigh" },
			},
		});
		expect(c.agents).toEqual({
			builder: { adapter: "claude", model: "sonnet", effort: "max" },
			critic: { adapter: "codex", model: "gpt-5.5", reasoningEffort: "xhigh" },
		});
	});

	test("parses profiles as the preferred name, including string shorthand", () => {
		const c = parse({ ...VALID, profiles: { builder: "codex:gpt-5.5", critic: "gemini" } });
		expect(c.agents).toEqual({ builder: { adapter: "codex", model: "gpt-5.5" }, critic: { adapter: "gemini" } });
	});

	test("rejects using both profiles and agents", () => {
		expect(() => parse({ ...VALID, profiles: {}, agents: {} })).toThrow(/use one/);
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

	test("rejects invalid or adapter-mismatched profile effort settings", () => {
		expect(() => parse({ ...VALID, profiles: { x: { adapter: "claude", effort: "xhigh" } } })).toThrow(/effort.*must be one/);
		expect(() => parse({ ...VALID, profiles: { x: { adapter: "codex", effort: "max" } } })).toThrow(/only supported by the claude adapter/);
		expect(() => parse({ ...VALID, profiles: { x: { adapter: "codex", reasoningEffort: "max" } } })).toThrow(/reasoningEffort.*must be one/);
		expect(() => parse({ ...VALID, profiles: { x: { adapter: "claude", reasoningEffort: "xhigh" } } })).toThrow(/only supported by the codex adapter/);
		expect(() => parse({ ...VALID, profiles: { x: { adapter: "gemini", reasoningEffort: "xhigh" } } })).toThrow(/only supported by the codex adapter/);
	});
});

describe("parseConfig -- built-in adapter/model validation (the runtime guard)", () => {
	test("rejects an impossible built-in pair before execution (shorthand and object)", () => {
		expect(() => parse({ ...VALID, profiles: { x: "codex:sonnet" } })).toThrow(/model "sonnet" is not valid for adapter "codex"/);
		expect(() => parse({ ...VALID, profiles: { x: "claude:gpt-5.5" } })).toThrow(/model "gpt-5.5" is not valid for adapter "claude"/);
		expect(() => parse({ ...VALID, agents: { x: { adapter: "gemini", model: "opus" } } })).toThrow(/not valid for adapter "gemini"/);
	});

	test("rejects a custom adapter in shorthand (must use the object form)", () => {
		expect(() => parse({ ...VALID, profiles: { x: "my-adapter:m" } })).toThrow(/unknown adapter "my-adapter"/);
	});

	test("rejects a trailing ':' with no model for every built-in (the parser/schema drift trap)", () => {
		for (const s of ["codex:", "claude:", "gemini:"]) {
			expect(() => parse({ ...VALID, profiles: { x: s } })).toThrow(/trailing ":" but no model/);
		}
	});

	test("accepts a bare built-in (no colon) as the default model -- what the trailing-colon error points to", () => {
		const c = parse({ ...VALID, profiles: { a: "codex", b: "claude", c: "gemini" } });
		expect(c.agents).toEqual({ a: { adapter: "codex" }, b: { adapter: "claude" }, c: { adapter: "gemini" } });
	});

	test("accepts valid built-in pairs, full names, default, and omitted model", () => {
		expect(() => parse({ ...VALID, profiles: { a: "codex:gpt-5.5", b: "claude:sonnet", c: "claude:claude-opus-4-8", d: "gemini", e: "claude:default" } })).not.toThrow();
	});

	test("leaves a custom adapter's model opaque in the object form", () => {
		expect(() => parse({ ...VALID, agents: { x: { adapter: "my-adapter", model: "whatever" } } })).not.toThrow();
	});
});
