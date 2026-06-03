import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@chit-run/core";
import { loadConfig } from "./load.ts";

// The node-side config loader: reads ONE file (config.json), no agents.json
// fallback. Structure validation is the core parser's job (covered there); here we
// pin the file behavior: missing file, valid file, invalid JSON.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-config-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a missing config file yields built-in agents and no roles", () => {
	const c = loadConfig(join(dir, "config.json"));
	expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
	expect(c.roles).toEqual({});
	expect(c.configPath).toBeUndefined();
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
	const c = loadConfig(path);
	expect(c.registry.agents["codex-deep"]).toBeDefined();
	expect(c.roles.reviewer?.agent).toBe("codex-deep");
	expect(c.configPath).toBe(path);
});

test("invalid JSON throws a ConfigError naming the path", () => {
	const path = join(dir, "config.json");
	writeFileSync(path, "{ not json");
	let caught: unknown;
	try {
		loadConfig(path);
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
		const c = loadConfig();
		expect(c.registry.agents["kimi-cloud"]).toBeDefined();
		expect(c.configPath).toBe(join(dir, "chit", "config.json"));
	});

	test("falls back to built-ins when the default config file is absent", () => {
		const c = loadConfig();
		expect(Object.keys(c.registry.agents).sort()).toEqual(["claude", "codex"]);
		expect(c.roles).toEqual({});
		expect(c.configPath).toBeUndefined();
	});
});
