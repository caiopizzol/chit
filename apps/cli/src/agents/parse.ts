// File-backed registry loader. Reads ~/.config/chit/agents.json (or an explicit
// path), parses it via the browser-safe registry module, and
// returns a normalized registry. This is the only module in src/agents/
// that touches node:fs / node:os / node:path; pure consumers should
// import from ./registry.ts instead.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type NormalizedRegistry, parseRegistry, RegistryError } from "@chit/core";

function defaultConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(xdg, "chit", "agents.json");
}

export function loadRegistry(configPath?: string): NormalizedRegistry {
	const path = configPath ?? defaultConfigPath();
	if (!existsSync(path)) {
		// parseRegistry(undefined) returns just the built-in agents.
		return parseRegistry(undefined);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new RegistryError(path, `invalid JSON: ${(e as Error).message}`);
	}

	const reg = parseRegistry(raw, path);
	return { ...reg, configPath: path };
}

// Re-export RegistryError so existing call sites that catch errors from
// loadRegistry can keep their import path stable.
export { RegistryError } from "@chit/core";
