import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
