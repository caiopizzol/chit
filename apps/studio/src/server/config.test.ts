// Unit tests for the NormalizedConfig -> EffectiveConfigView mapping: origin
// resolution, layer-then-id ordering, env redaction to key names, the
// claude-cli-only flags, and the bounded instructions preview.

import { describe, expect, test } from "bun:test";
import { type ConfigLayer, parseConfig, parseConfigLayers } from "@chit-run/core";
import { effectiveConfigView, effectiveRecipeViews, instructionsPreview } from "./config.ts";

function layered(global?: unknown, repo?: unknown) {
	const layers: ConfigLayer[] = [];
	if (global !== undefined)
		layers.push({ raw: global, path: "/home/u/config.json", source: "global" });
	if (repo !== undefined)
		layers.push({ raw: repo, path: "/repo/chit.config.json", source: "repo" });
	const config = parseConfigLayers(layers);
	if (global !== undefined) config.configPath = "/home/u/config.json";
	if (repo !== undefined) config.repoConfigPath = "/repo/chit.config.json";
	return config;
}

describe("effectiveConfigView", () => {
	test("defaults-only config: builtin agents, no roles, no paths", () => {
		const view = effectiveConfigView(parseConfig(undefined));
		expect(view.configPath).toBeUndefined();
		expect(view.repoConfigPath).toBeUndefined();
		expect(view.roles).toEqual([]);
		expect(view.agents.map((a) => a.id)).toEqual(["claude", "codex"]);
		for (const agent of view.agents) expect(agent.origin).toBe("builtin");
	});

	test("orders agents by layer (builtin, global, repo) then id", () => {
		const config = layered(
			{ agents: { "g-two": { adapter: "codex-exec" }, "g-one": { adapter: "codex-exec" } } },
			{ agents: { "r-one": { adapter: "claude-cli" } } },
		);
		const view = effectiveConfigView(config);
		expect(view.agents.map((a) => `${a.origin}:${a.id}`)).toEqual([
			"builtin:claude",
			"builtin:codex",
			"global:g-one",
			"global:g-two",
			"repo:r-one",
		]);
		expect(view.configPath).toBe("/home/u/config.json");
		expect(view.repoConfigPath).toBe("/repo/chit.config.json");
	});

	test("a repo redefinition of a global agent reports the repo origin", () => {
		const config = layered(
			{ agents: { deep: { adapter: "codex-exec", model: "global-model" } } },
			{ agents: { deep: { adapter: "codex-exec", model: "repo-model" } } },
		);
		const agent = effectiveConfigView(config).agents.find((a) => a.id === "deep");
		expect(agent?.origin).toBe("repo");
		expect(agent?.model).toBe("repo-model");
	});

	test("env values are redacted to sorted key names", () => {
		const config = layered({
			agents: {
				custom: {
					adapter: "codex-exec",
					env: { ZED: "secret-value", ALPHA: "another-secret" },
				},
			},
		});
		const view = effectiveConfigView(config);
		const agent = view.agents.find((a) => a.id === "custom");
		expect(agent?.envKeys).toEqual(["ALPHA", "ZED"]);
		expect(JSON.stringify(view)).not.toContain("secret-value");
		expect(JSON.stringify(view)).not.toContain("another-secret");
	});

	test("strictMcp/passModelOnResume appear only for claude-cli, as effective values", () => {
		const config = layered({
			agents: {
				"my-claude": { adapter: "claude-cli", strictMcp: false, passModelOnResume: true },
				"my-codex": { adapter: "codex-exec" },
			},
		});
		const view = effectiveConfigView(config);
		const claude = view.agents.find((a) => a.id === "my-claude");
		expect(claude?.strictMcp).toBe(false);
		expect(claude?.passModelOnResume).toBe(true);
		// Builtin claude: undefined strictMcp means the adapter default (on).
		expect(view.agents.find((a) => a.id === "claude")?.strictMcp).toBe(true);
		const codex = view.agents.find((a) => a.id === "my-codex");
		expect(codex?.strictMcp).toBeUndefined();
		expect(codex?.passModelOnResume).toBeUndefined();
	});

	test("carries the optional display fields when set", () => {
		const config = layered({
			agents: {
				deep: {
					adapter: "codex-exec",
					model: "gpt-5.3-codex",
					reasoningEffort: "xhigh",
					callTimeoutMs: 1_200_000,
					noProgressTimeoutMs: 300_000,
					description: "deep reviewer",
				},
			},
		});
		const agent = effectiveConfigView(config).agents.find((a) => a.id === "deep");
		expect(agent).toMatchObject({
			model: "gpt-5.3-codex",
			reasoningEffort: "xhigh",
			callTimeoutMs: 1_200_000,
			noProgressTimeoutMs: 300_000,
			description: "deep reviewer",
		});
	});

	test("roles carry origin, governance, and a preview, never full instructions", () => {
		const longInstructions = `You are a meticulous reviewer.\n${"Focus on correctness. ".repeat(40)}`;
		const config = layered(
			{
				roles: {
					reviewer: {
						agent: "codex",
						instructions: longInstructions,
						session: "per_scope",
						permissions: { filesystem: "read_only" },
					},
				},
			},
			{
				roles: {
					implementer: { instructions: "Implement the slice.", session: "stateless" },
				},
			},
		);
		const view = effectiveConfigView(config);
		expect(view.roles.map((r) => `${r.origin}:${r.id}`)).toEqual([
			"global:reviewer",
			"repo:implementer",
		]);
		const reviewer = view.roles.find((r) => r.id === "reviewer");
		expect(reviewer?.agent).toBe("codex");
		expect(reviewer?.session).toBe("per_scope");
		expect(reviewer?.filesystem).toBe("read_only");
		expect(reviewer?.instructionsLength).toBe(longInstructions.length);
		expect(reviewer?.instructionsPreview.length).toBeLessThanOrEqual(140);
		expect(JSON.stringify(view).length).toBeLessThan(longInstructions.length);
		// Model-agnostic role: no agent, default read_only filesystem.
		const implementer = view.roles.find((r) => r.id === "implementer");
		expect(implementer?.agent).toBeUndefined();
		expect(implementer?.filesystem).toBe("read_only");
	});
});

describe("effectiveConfigView recipes", () => {
	test("defaults-only config has no recipes", () => {
		expect(effectiveConfigView(parseConfig(undefined)).recipes).toEqual([]);
	});

	test("orders recipes by layer (global, repo) then id, with provenance origin", () => {
		const config = layered(
			{
				recipes: {
					"g-two": { mode: "converge", manifestPath: "/flows/two.json" },
					"g-one": { mode: "converge", manifestPath: "/flows/one.json" },
				},
			},
			{ recipes: { "r-one": { mode: "converge", manifestPath: "flows/repo.json" } } },
		);
		const view = effectiveConfigView(config);
		expect(view.recipes.map((r) => `${r.origin}:${r.id}`)).toEqual([
			"global:g-one",
			"global:g-two",
			"repo:r-one",
		]);
	});

	test("carries mode, manifest path, and the optional loop knobs when set", () => {
		const config = layered({
			recipes: {
				deep: {
					mode: "converge",
					manifestPath: "/flows/deep.json",
					maxIterations: 5,
					callTimeoutMs: 1_200_000,
					description: "deep converge preset",
				},
			},
		});
		const recipe = effectiveConfigView(config).recipes.find((r) => r.id === "deep");
		expect(recipe).toEqual({
			id: "deep",
			origin: "global",
			mode: "converge",
			manifestPath: "/flows/deep.json",
			maxIterations: 5,
			callTimeoutMs: 1_200_000,
			description: "deep converge preset",
		});
	});

	test("carries one-shot recipes without loop knobs", () => {
		const config = layered({
			recipes: {
				grill: {
					mode: "one-shot",
					manifestPath: "/flows/grill.json",
					description: "question loop",
				},
			},
		});
		const recipe = effectiveConfigView(config).recipes.find((r) => r.id === "grill");
		expect(recipe).toEqual({
			id: "grill",
			origin: "global",
			mode: "one-shot",
			manifestPath: "/flows/grill.json",
			description: "question loop",
		});
	});

	test("a recipe with no optional knobs carries only the contracted fields", () => {
		const config = layered({
			recipes: { bare: { mode: "converge", manifestPath: "/flows/bare.json" } },
		});
		const recipe = effectiveConfigView(config).recipes.find((r) => r.id === "bare");
		// Field-by-field rebuild: absent optionals stay absent, never spread in as
		// undefined keys.
		expect(Object.keys(recipe ?? {}).sort()).toEqual(["id", "manifestPath", "mode", "origin"]);
	});
});

describe("effectiveRecipeViews", () => {
	test("is the same redacted recipe list effectiveConfigView produces", () => {
		const config = layered(
			{
				recipes: {
					deep: {
						mode: "converge",
						manifestPath: "/flows/deep.json",
						maxIterations: 5,
						callTimeoutMs: 1_200_000,
						description: "deep converge preset",
					},
				},
			},
			{ recipes: { repo: { mode: "converge", manifestPath: "flows/repo.json" } } },
		);
		// The shared helper and the full config view must never diverge: one
		// redaction shape, reused by both Studio and the MCP recipe tool.
		expect(effectiveRecipeViews(config)).toEqual(effectiveConfigView(config).recipes);
	});

	test("redacts to the contracted fields with provenance origin, layer-then-id ordered", () => {
		const config = layered(
			{
				recipes: {
					"g-two": { mode: "converge", manifestPath: "/flows/two.json" },
					"g-one": { mode: "converge", manifestPath: "/flows/one.json" },
				},
			},
			{ recipes: { "r-one": { mode: "converge", manifestPath: "flows/repo.json" } } },
		);
		const recipes = effectiveRecipeViews(config);
		expect(recipes.map((r) => `${r.origin}:${r.id}`)).toEqual([
			"global:g-one",
			"global:g-two",
			"repo:r-one",
		]);
		// Origin is the layer only -- the defining file PATH never crosses per recipe.
		for (const r of recipes) expect(r).not.toHaveProperty("path");
	});

	test("defaults-only config has an empty menu", () => {
		expect(effectiveRecipeViews(parseConfig(undefined))).toEqual([]);
	});
});

describe("instructionsPreview", () => {
	test("collapses whitespace and keeps short instructions whole", () => {
		expect(instructionsPreview("  Be \n\n concise.\t Always. ")).toBe("Be concise. Always.");
	});

	test("truncates long instructions with a cut marker", () => {
		const out = instructionsPreview("word ".repeat(100));
		expect(out.endsWith("...")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(140);
	});
});
