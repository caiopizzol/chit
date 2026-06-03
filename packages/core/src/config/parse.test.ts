import { describe, expect, test } from "bun:test";
import { parseConfig } from "./parse.ts";
import { ConfigError } from "./types.ts";

// parseConfig owns agents + roles in one config. Agents reuse the registry parser
// (built-ins merged); roles are behavior + governance with an OPTIONAL default
// agent. These tests pin the Stage 3 contract: model-agnostic role, role with a
// default agent, malformed role, unknown role shape, and an unknown agent in a
// role default. Resolution against a manifest is a later stage; this is parse only.

describe("parseConfig: empty / agents only", () => {
	test("undefined config -> built-in agents, no roles", () => {
		const c = parseConfig(undefined);
		expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
		expect(c.roles).toEqual({});
	});

	test("agents section is parsed and merged with built-ins", () => {
		const c = parseConfig({
			agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-codex" } },
		});
		expect(c.registry.agents["codex-deep"]?.adapter).toBe("codex-exec");
		expect(c.registry.agents.claude).toBeDefined(); // built-in still present
		expect(c.roles).toEqual({});
	});

	test("rejects an unknown top-level field", () => {
		expect(() => parseConfig({ rolez: {} })).toThrow(ConfigError);
	});

	test("rejects a non-object top-level", () => {
		expect(() => parseConfig(42)).toThrow(ConfigError);
	});
});

describe("parseConfig: roles", () => {
	test("a model-agnostic role (no default agent) is valid", () => {
		const c = parseConfig({
			roles: {
				reviewer: {
					instructions: "Review the diff skeptically.",
					permissions: { filesystem: "read_only" },
					session: "per_scope",
				},
			},
		});
		const r = c.roles.reviewer;
		expect(r).toBeDefined();
		expect(r?.agent).toBeUndefined(); // model-agnostic: no default
		expect(r?.instructions).toBe("Review the diff skeptically.");
		expect(r?.session).toBe("per_scope");
		expect(r?.permissions.filesystem).toBe("read_only");
	});

	test("a role with a default agent resolves it against the registry (built-in)", () => {
		const c = parseConfig({
			roles: {
				implementer: { agent: "claude", instructions: "Implement a slice.", session: "per_scope" },
			},
		});
		expect(c.roles.implementer?.agent).toBe("claude");
		// permissions defaults to read_only when omitted (same as a participant)
		expect(c.roles.implementer?.permissions.filesystem).toBe("read_only");
	});

	test("a role can default to a user-defined agent in the same config", () => {
		const c = parseConfig({
			agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-codex" } },
			roles: {
				reviewer: { agent: "codex-deep", instructions: "Review.", session: "per_scope" },
			},
		});
		expect(c.roles.reviewer?.agent).toBe("codex-deep");
	});

	test("an unknown agent in a role default is a ConfigError", () => {
		expect(() =>
			parseConfig({
				roles: { reviewer: { agent: "ghost", instructions: "Review.", session: "per_scope" } },
			}),
		).toThrow(/unknown agent "ghost"/);
	});

	test("a malformed role (missing instructions) is a ConfigError", () => {
		expect(() => parseConfig({ roles: { reviewer: { session: "per_scope" } } })).toThrow(
			/instructions/,
		);
	});

	test("a malformed role (missing session) is a ConfigError", () => {
		expect(() => parseConfig({ roles: { reviewer: { instructions: "Review." } } })).toThrow(
			/session/,
		);
	});

	test("an invalid session value is a ConfigError", () => {
		expect(() =>
			parseConfig({ roles: { reviewer: { instructions: "Review.", session: "sometimes" } } }),
		).toThrow(/session/);
	});

	test("an unknown role field is a ConfigError", () => {
		expect(() =>
			parseConfig({
				roles: { reviewer: { instructions: "Review.", session: "per_scope", color: "blue" } },
			}),
		).toThrow(/unknown field "color"/);
	});

	test("an unknown role shape (role is not an object) is a ConfigError", () => {
		expect(() => parseConfig({ roles: { reviewer: "just a string" } })).toThrow(ConfigError);
	});

	test("a non-kebab role id is a ConfigError", () => {
		expect(() =>
			parseConfig({ roles: { Reviewer: { instructions: "R.", session: "per_scope" } } }),
		).toThrow(/kebab/);
	});

	test("an invalid filesystem permission is a ConfigError", () => {
		expect(() =>
			parseConfig({
				roles: {
					reviewer: {
						instructions: "R.",
						session: "per_scope",
						permissions: { filesystem: "sudo" },
					},
				},
			}),
		).toThrow(/filesystem/);
	});

	test("a non-string agent default is a ConfigError", () => {
		expect(() =>
			parseConfig({
				roles: { reviewer: { agent: 7, instructions: "R.", session: "per_scope" } },
			}),
		).toThrow(/agent/);
	});
});
