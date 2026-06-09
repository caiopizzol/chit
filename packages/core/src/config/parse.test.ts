import { describe, expect, test } from "bun:test";
import { RegistryError } from "../agents/registry.ts";
import { type ConfigLayer, parseConfig, parseConfigLayers } from "./parse.ts";
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

// Layering: built-ins -> global -> repo. Later layers replace user-defined
// entities WHOLE (no field merging); built-ins are non-redefinable in every
// layer; the repo layer is untrusted and may not set env/strictMcp; provenance
// records one origin per effective entity.
describe("parseConfigLayers", () => {
	const GLOBAL = "/home/u/.config/chit/config.json";
	const REPO = "/repo/chit.config.json";

	function layers(global: unknown, repo: unknown): ConfigLayer[] {
		const out: ConfigLayer[] = [];
		if (global !== undefined) out.push({ raw: global, path: GLOBAL, source: "global" });
		if (repo !== undefined) out.push({ raw: repo, path: REPO, source: "repo" });
		return out;
	}

	test("no layers -> built-ins only, with builtin provenance", () => {
		const c = parseConfigLayers([]);
		expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
		expect(c.roles).toEqual({});
		expect(c.provenance?.agents.codex).toEqual({ source: "builtin" });
		expect(c.provenance?.agents.claude).toEqual({ source: "builtin" });
	});

	test("a global-only stack matches single-file parseConfig", () => {
		const raw = {
			agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-codex" } },
			roles: { reviewer: { instructions: "Review.", session: "per_scope" } },
		};
		const layered = parseConfigLayers(layers(raw, undefined));
		const single = parseConfig(raw, GLOBAL);
		expect(layered.registry).toEqual(single.registry);
		expect(layered.roles).toEqual(single.roles);
		expect(layered.provenance?.agents["codex-deep"]).toEqual({ source: "global", path: GLOBAL });
	});

	test("a repo agent replaces a global agent WHOLE (no field merging)", () => {
		const c = parseConfigLayers(
			layers(
				{
					agents: {
						"codex-deep": {
							adapter: "codex-exec",
							model: "gpt-5-codex",
							description: "deep reasoning",
						},
					},
				},
				{ agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-mini" } } },
			),
		);
		const agent = c.registry.agents["codex-deep"];
		expect(agent?.model).toBe("gpt-5-mini");
		// Whole-entity replacement: the global description does NOT survive.
		expect(agent?.description).toBeUndefined();
		expect(c.provenance?.agents["codex-deep"]).toEqual({ source: "repo", path: REPO });
	});

	test("a repo role replaces a global role WHOLE (no field merging)", () => {
		const c = parseConfigLayers(
			layers(
				{
					roles: {
						reviewer: {
							agent: "claude",
							instructions: "Review gently.",
							session: "per_topology",
							permissions: { filesystem: "write" },
						},
					},
				},
				{ roles: { reviewer: { instructions: "Review skeptically.", session: "per_scope" } } },
			),
		);
		const role = c.roles.reviewer;
		expect(role?.instructions).toBe("Review skeptically.");
		expect(role?.session).toBe("per_scope");
		// Whole-entity replacement: the global agent default and write permission do
		// NOT survive; the repo definition's defaults apply.
		expect(role?.agent).toBeUndefined();
		expect(role?.permissions.filesystem).toBe("read_only");
		expect(c.provenance?.roles.reviewer).toEqual({ source: "repo", path: REPO });
	});

	test("entities NOT redefined by the repo layer keep their global origin", () => {
		const c = parseConfigLayers(
			layers(
				{
					agents: { "codex-deep": { adapter: "codex-exec" } },
					roles: { reviewer: { instructions: "Review.", session: "per_scope" } },
				},
				{ agents: { "repo-agent": { adapter: "claude-cli" } } },
			),
		);
		expect(c.provenance?.agents["codex-deep"]).toEqual({ source: "global", path: GLOBAL });
		expect(c.provenance?.agents["repo-agent"]).toEqual({ source: "repo", path: REPO });
		expect(c.provenance?.roles.reviewer).toEqual({ source: "global", path: GLOBAL });
	});

	test("a repo role may reference an agent defined in the global layer", () => {
		const c = parseConfigLayers(
			layers(
				{ agents: { "codex-deep": { adapter: "codex-exec" } } },
				{ roles: { reviewer: { agent: "codex-deep", instructions: "R.", session: "per_scope" } } },
			),
		);
		expect(c.roles.reviewer?.agent).toBe("codex-deep");
	});

	test("the repo layer cannot redefine a built-in agent", () => {
		expect(() =>
			parseConfigLayers(layers(undefined, { agents: { codex: { adapter: "codex-exec" } } })),
		).toThrow(RegistryError);
		expect(() =>
			parseConfigLayers(layers(undefined, { agents: { claude: { adapter: "claude-cli" } } })),
		).toThrow(/built-in agent id cannot be redefined/);
	});

	test("the repo layer rejects env loudly (trust boundary)", () => {
		expect(() =>
			parseConfigLayers(
				layers(undefined, {
					agents: { sneaky: { adapter: "codex-exec", env: { PATH: "/evil" } } },
				}),
			),
		).toThrow(/"env" is not allowed in repo config \(trust boundary\)/);
	});

	test("the repo layer rejects strictMcp loudly (trust boundary)", () => {
		expect(() =>
			parseConfigLayers(
				layers(undefined, { agents: { sneaky: { adapter: "claude-cli", strictMcp: false } } }),
			),
		).toThrow(/"strictMcp" is not allowed in repo config \(trust boundary\)/);
	});

	test("the global layer may still use env and strictMcp", () => {
		const c = parseConfigLayers(
			layers(
				{
					agents: {
						tuned: { adapter: "claude-cli", env: { FOO: "bar" }, strictMcp: false },
					},
				},
				undefined,
			),
		);
		expect(c.registry.agents.tuned?.env).toEqual({ FOO: "bar" });
		expect(c.registry.agents.tuned?.strictMcp).toBe(false);
	});

	test("an unknown top-level field in the repo layer names the repo path", () => {
		let caught: unknown;
		try {
			parseConfigLayers(layers(undefined, { rolez: {} }));
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConfigError);
		expect((caught as ConfigError).path).toBe(REPO);
	});
});

describe("parseConfig: profiles are no longer accepted", () => {
	test("a `profiles` section is rejected as an unknown top-level field", () => {
		expect(() =>
			parseConfig({ profiles: { "deep-converge": { manifestPath: "/vetted/converge.json" } } }),
		).toThrow(/unknown top-level field "profiles"/);
	});

	test("the parsed config carries no profiles surface", () => {
		const c = parseConfig({ agents: {}, roles: {} });
		expect((c as { profiles?: unknown }).profiles).toBeUndefined();
	});
});
