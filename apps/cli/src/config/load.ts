// File-backed config loader. Layers two files over the built-ins:
//   1. the global config at ~/.config/chit/config.json (or an explicit path),
//   2. the repo config at <git top-level>/chit.config.json (cwd outside git).
// Both are parsed by the browser-safe core layering engine; later layers replace
// user-defined agents/roles/recipes whole, built-ins stay non-redefinable, and
// the repo layer is treated as untrusted project input (env/strictMcp rejected,
// recipe manifestPath confined to the repo - both enforced in core).
//
// The repo file deliberately lives at the repo ROOT, visible and diffable, NOT
// under .chit/: converge drops .chit/** from changedFiles (workspace.ts), so a
// config there would be invisible to converge review.
//
// This is the ONE read path: there is no agents.json fallback. The agents.json ->
// config.json move is a clean break (0.x, no back-compat); migration, if wanted,
// is an explicit rename, not a second read path. This is the only module in
// src/config/ that touches node:fs / os / path.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ConfigError,
	type ConfigLayer,
	type NormalizedConfig,
	parseConfigLayers,
} from "@chit-run/core";
import { repoRoot } from "../loops/location.ts";

export const REPO_CONFIG_FILENAME = "chit.config.json";

function defaultConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(xdg, "chit", "config.json");
}

// Read and JSON-parse a config file; undefined when the file is absent. A present
// but malformed file throws loudly (never silently skipped), naming the path.
function readConfigFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new ConfigError(path, `invalid JSON: ${(e as Error).message}`);
	}
}

export interface LoadConfigOptions {
	// Where repo-config discovery starts: the git top-level of cwd, or cwd itself
	// outside a git work tree. Defaults to process.cwd().
	cwd?: string;
}

export function loadConfig(configPath?: string, opts: LoadConfigOptions = {}): NormalizedConfig {
	const globalPath = configPath ?? defaultConfigPath();
	const globalRaw = readConfigFile(globalPath);

	const repoPath = join(repoRoot(opts.cwd ?? process.cwd()), REPO_CONFIG_FILENAME);
	const repoRaw = readConfigFile(repoPath);

	const layers: ConfigLayer[] = [];
	if (globalRaw !== undefined) layers.push({ raw: globalRaw, path: globalPath, source: "global" });
	if (repoRaw !== undefined) layers.push({ raw: repoRaw, path: repoPath, source: "repo" });

	const config = parseConfigLayers(layers);
	if (globalRaw !== undefined) config.configPath = globalPath;
	if (repoRaw !== undefined) config.repoConfigPath = repoPath;
	return config;
}

// Re-export ConfigError so call sites that catch loader errors keep a stable path.
export { ConfigError } from "@chit-run/core";
