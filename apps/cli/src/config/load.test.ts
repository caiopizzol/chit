import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@chit-run/core";
import { loadConfig, REPO_CONFIG_FILENAME } from "./load.ts";

// The node-side config loader: layers the global config.json and the repo's
// chit.config.json over the built-ins. Structure/layering validation is the core
// parser's job (covered there); here we pin the FILE behavior: missing files,
// valid files, invalid JSON, and repo discovery (git top-level, cwd fallback).
// Every test passes an explicit cwd so the suite never depends on where bun runs.

let dir: string;
// A second temp dir used as a repo-config-free cwd, so global-only tests stay
// hermetic even if the suite's own repo ever gained a chit.config.json.
let plainCwd: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-config-"));
	plainCwd = mkdtempSync(join(tmpdir(), "chit-cwd-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(plainCwd, { recursive: true, force: true });
});

test("a missing config file yields built-in agents and no roles", () => {
	const c = loadConfig(join(dir, "config.json"), { cwd: plainCwd });
	expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
	expect(c.roles).toEqual({});
	expect(c.configPath).toBeUndefined();
	expect(c.repoConfigPath).toBeUndefined();
});

test("a valid config file is parsed (agents + roles) and records its path", () => {
	const path = join(dir, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-codex" } },
			roles: {
				reviewer: {
					agent: "codex-deep",
					instructions: "Review.",
					session: "per_scope",
					permissions: { filesystem: "read_only" },
				},
			},
		}),
	);
	const c = loadConfig(path, { cwd: plainCwd });
	expect(c.registry.agents["codex-deep"]).toBeDefined();
	expect(c.roles.reviewer?.agent).toBe("codex-deep");
	expect(c.configPath).toBe(path);
	expect(c.repoConfigPath).toBeUndefined();
});

test("invalid JSON throws a ConfigError naming the path", () => {
	const path = join(dir, "config.json");
	writeFileSync(path, "{ not json");
	let caught: unknown;
	try {
		loadConfig(path, { cwd: plainCwd });
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ConfigError);
	expect((caught as ConfigError).path).toBe(path);
});

// The no-argument form resolves $XDG_CONFIG_HOME/chit/config.json. This is the
// production entry every surface uses, so its default-path resolution is pinned
// here (it used to be covered against the removed agents.json loader).
describe("loadConfig: default path resolution (no explicit path)", () => {
	let prevXdg: string | undefined;
	beforeEach(() => {
		prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = dir; // outer beforeEach created `dir`
	});
	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
	});

	test("reads $XDG_CONFIG_HOME/chit/config.json when present", () => {
		mkdirSync(join(dir, "chit"), { recursive: true });
		writeFileSync(
			join(dir, "chit", "config.json"),
			JSON.stringify({
				agents: { "kimi-cloud": { adapter: "claude-cli", model: "k", passModelOnResume: true } },
			}),
		);
		const c = loadConfig(undefined, { cwd: plainCwd });
		expect(c.registry.agents["kimi-cloud"]).toBeDefined();
		expect(c.configPath).toBe(join(dir, "chit", "config.json"));
	});

	test("falls back to built-ins when the default config file is absent", () => {
		const c = loadConfig(undefined, { cwd: plainCwd });
		expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
		expect(c.roles).toEqual({});
		expect(c.configPath).toBeUndefined();
	});
});

// Repo-layer discovery and trust rules. The merge semantics themselves are pinned
// in core (parseConfigLayers); these tests pin where the file is FOUND and that
// the loader feeds it through as the untrusted repo layer.
describe("loadConfig: repo config (chit.config.json)", () => {
	function gitInit(repo: string): void {
		const r = spawnSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
		if (r.status !== 0) throw new Error("git init failed");
	}

	test("outside git, chit.config.json is discovered in cwd itself", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({ agents: { "repo-agent": { adapter: "codex-exec" } } }),
		);
		const c = loadConfig(join(dir, "config.json"), { cwd: plainCwd });
		expect(c.registry.agents["repo-agent"]).toBeDefined();
		expect(c.repoConfigPath).toBe(join(realpathSync(plainCwd), REPO_CONFIG_FILENAME));
		expect(c.provenance?.agents["repo-agent"]?.source).toBe("repo");
	});

	test("inside git, chit.config.json at the top-level is discovered from a subdirectory", () => {
		gitInit(plainCwd);
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({ agents: { "repo-agent": { adapter: "codex-exec" } } }),
		);
		const sub = join(plainCwd, "src", "deep");
		mkdirSync(sub, { recursive: true });
		const c = loadConfig(join(dir, "config.json"), { cwd: sub });
		expect(c.registry.agents["repo-agent"]).toBeDefined();
		expect(c.repoConfigPath).toBe(join(realpathSync(plainCwd), REPO_CONFIG_FILENAME));
	});

	test("no repo config preserves global-only behavior exactly", () => {
		const globalPath = join(dir, "config.json");
		writeFileSync(
			globalPath,
			JSON.stringify({ agents: { "codex-deep": { adapter: "codex-exec" } } }),
		);
		const c = loadConfig(globalPath, { cwd: plainCwd });
		expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex", "codex-deep"]);
		expect(c.configPath).toBe(globalPath);
		expect(c.repoConfigPath).toBeUndefined();
	});

	test("a repo config replaces a global user-defined agent and role whole", () => {
		const globalPath = join(dir, "config.json");
		writeFileSync(
			globalPath,
			JSON.stringify({
				agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-codex" } },
				roles: { reviewer: { agent: "codex-deep", instructions: "Old.", session: "per_scope" } },
			}),
		);
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({
				agents: { "codex-deep": { adapter: "codex-exec", model: "gpt-5-mini" } },
				roles: { reviewer: { instructions: "New.", session: "per_scope" } },
			}),
		);
		const c = loadConfig(globalPath, { cwd: plainCwd });
		expect(c.registry.agents["codex-deep"]?.model).toBe("gpt-5-mini");
		expect(c.roles.reviewer?.instructions).toBe("New.");
		// Whole-entity replacement: the global role's default agent does not survive.
		expect(c.roles.reviewer?.agent).toBeUndefined();
		expect(c.provenance?.agents["codex-deep"]?.source).toBe("repo");
		expect(c.provenance?.roles.reviewer?.source).toBe("repo");
	});

	test("a repo config cannot redefine the built-in agents", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({ agents: { codex: { adapter: "codex-exec", model: "evil" } } }),
		);
		expect(() => loadConfig(join(dir, "config.json"), { cwd: plainCwd })).toThrow(
			/built-in agent id cannot be redefined/,
		);
	});

	test("a repo config rejects env (trust boundary), loudly", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({ agents: { sneaky: { adapter: "codex-exec", env: { PATH: "/evil" } } } }),
		);
		expect(() => loadConfig(join(dir, "config.json"), { cwd: plainCwd })).toThrow(
			/"env" is not allowed in repo config/,
		);
	});

	test("a repo config rejects strictMcp (trust boundary), loudly", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({ agents: { sneaky: { adapter: "claude-cli", strictMcp: false } } }),
		);
		expect(() => loadConfig(join(dir, "config.json"), { cwd: plainCwd })).toThrow(
			/"strictMcp" is not allowed in repo config/,
		);
	});

	test("a repo config may define recipes with repo-relative manifest paths", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({
				recipes: { "deep-review": { mode: "converge", manifestPath: "manifests/review.json" } },
			}),
		);
		const c = loadConfig(join(dir, "config.json"), { cwd: plainCwd });
		expect(c.recipes["deep-review"]?.manifestPath).toBe("manifests/review.json");
		expect(c.provenance?.recipes["deep-review"]?.source).toBe("repo");
	});

	test("a repo recipe with an absolute manifestPath is rejected (trust boundary)", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({
				recipes: { sneaky: { mode: "converge", manifestPath: "/etc/evil.json" } },
			}),
		);
		expect(() => loadConfig(join(dir, "config.json"), { cwd: plainCwd })).toThrow(
			/repo-relative.*trust boundary/,
		);
	});

	test("a repo recipe with `..` traversal is rejected (trust boundary)", () => {
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({
				recipes: { sneaky: { mode: "converge", manifestPath: "../outside.json" } },
			}),
		);
		expect(() => loadConfig(join(dir, "config.json"), { cwd: plainCwd })).toThrow(
			/may not contain ".."/,
		);
	});

	test("a global recipe may use an absolute manifestPath (operator input)", () => {
		const globalPath = join(dir, "config.json");
		writeFileSync(
			globalPath,
			JSON.stringify({
				recipes: { vetted: { mode: "converge", manifestPath: "/vetted/review.json" } },
			}),
		);
		const c = loadConfig(globalPath, { cwd: plainCwd });
		expect(c.recipes.vetted?.manifestPath).toBe("/vetted/review.json");
		expect(c.provenance?.recipes.vetted?.source).toBe("global");
	});

	test("a repo recipe replaces a global recipe whole", () => {
		const globalPath = join(dir, "config.json");
		writeFileSync(
			globalPath,
			JSON.stringify({
				recipes: {
					"deep-review": {
						mode: "converge",
						manifestPath: "/vetted/review.json",
						maxIterations: 9,
					},
				},
			}),
		);
		writeFileSync(
			join(plainCwd, REPO_CONFIG_FILENAME),
			JSON.stringify({
				recipes: { "deep-review": { mode: "converge", manifestPath: "manifests/review.json" } },
			}),
		);
		const c = loadConfig(globalPath, { cwd: plainCwd });
		const r = c.recipes["deep-review"];
		expect(r?.manifestPath).toBe("manifests/review.json");
		expect(r?.mode).toBe("converge");
		if (r?.mode !== "converge") throw new Error("expected converge recipe");
		// Whole-entity replacement: the global maxIterations does not survive.
		expect(r.maxIterations).toBeUndefined();
		expect(c.provenance?.recipes["deep-review"]?.source).toBe("repo");
	});

	test("invalid JSON in the repo config throws a ConfigError naming the repo path", () => {
		writeFileSync(join(plainCwd, REPO_CONFIG_FILENAME), "{ not json");
		let caught: unknown;
		try {
			loadConfig(join(dir, "config.json"), { cwd: plainCwd });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConfigError);
		expect((caught as ConfigError).path).toBe(join(realpathSync(plainCwd), REPO_CONFIG_FILENAME));
	});
});
