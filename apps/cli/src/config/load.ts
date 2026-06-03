// File-backed config loader. Reads ~/.config/chit/config.json (or an explicit
// path), parses it via the browser-safe config module, and returns a normalized
// config (agents + roles). This is the ONE read path: there is no agents.json
// fallback. The agents.json -> config.json move is a clean break (0.x, no
// back-compat); migration, if wanted, is an explicit rename, not a second read
// path. This is the only module in src/config/ that touches node:fs / os / path.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, type NormalizedConfig, parseConfig } from "@chit-run/core";

function defaultConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(xdg, "chit", "config.json");
}

export function loadConfig(configPath?: string): NormalizedConfig {
	const path = configPath ?? defaultConfigPath();
	if (!existsSync(path)) {
		// No config file: built-in agents, no roles (parseConfig(undefined) handles it).
		return parseConfig(undefined);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new ConfigError(path, `invalid JSON: ${(e as Error).message}`);
	}

	return { ...parseConfig(raw, path), configPath: path };
}

// Re-export ConfigError so call sites that catch loader errors keep a stable path.
export { ConfigError } from "@chit-run/core";
