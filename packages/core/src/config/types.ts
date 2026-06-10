import type { NormalizedRegistry } from "../agents/types.ts";
import type { FilesystemPermission, SessionPolicy } from "../manifest/types.ts";

// chit's user config: agents (model profiles) + roles (reusable behavior +
// governance) + recipes (vetted manifest references), in one file
// (~/.config/chit/config.json). Parsed in core (this module is browser-safe:
// structure validation, no node:fs); the node-side loader reads the file. A
// manifest does NOT live here; a manifest's participants reference these roles,
// and resolution (registry + roles aware) happens at the run boundary, not in
// manifest parse.

export class ConfigError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "ConfigError";
	}
}

// A reusable role: behavior (instructions) + governance (permissions, session),
// optionally bound to a default agent. `agent` is OPTIONAL so a role can stay
// model-agnostic ("reviewer behavior, read-only, per-scope"); a participant that
// references the role then supplies (or overrides) the agent. When present, `agent`
// must resolve in the registry (checked at parse, since the registry is in hand).
export interface NormalizedRole {
	agent?: string;
	instructions: string;
	session: SessionPolicy;
	permissions: { filesystem: FilesystemPermission };
}

// A recipe: a named, vetted REFERENCE to an execution manifest, plus safe
// runtime defaults. Deliberately thin: it does NOT redeclare participants,
// prompts, checks, reviewer wiring, or approval policy; all of that lives in the
// manifest it points at. Recipes are references, not a second execution
// language. v1 supports only the converge mode.
export interface NormalizedRecipe {
	mode: "converge";
	manifestPath: string;
	maxIterations?: number;
	callTimeoutMs?: number;
	description?: string;
}

// Config layers a user can write. Built-ins are a third, implicit origin below
// both. Later layers win: global sits over built-ins, repo sits over global.
export type ConfigLayerSource = "global" | "repo";

// Where an effective entity came from: the layer that defined it, plus the file
// path for user layers. Replacement across layers is whole-entity (no field
// merging), so one origin fully describes the effective definition.
export interface ConfigOrigin {
	source: "builtin" | ConfigLayerSource;
	path?: string;
}

// Durable receipt shape for an approved recipe selection. This intentionally omits
// manifestPath because the resolved manifest is bound and surfaced separately; a recipe is
// a named reference layer, not a second manifest vocabulary.
export interface RecipeReceipt {
	id: string;
	origin?: ConfigOrigin;
	mode: "converge";
	maxIterations?: number;
	callTimeoutMs?: number;
	description?: string;
}

export interface ConfigProvenance {
	agents: Record<string, ConfigOrigin>;
	roles: Record<string, ConfigOrigin>;
	recipes: Record<string, ConfigOrigin>;
}

// The whole config: the agent registry (built-ins merged with the file's agents),
// the named roles, and the named recipes. `roles` / `recipes` are empty when the
// file declares none. configPath / repoConfigPath are the global and repo files
// that were actually read; provenance records, per effective agent, role, and
// recipe, which layer defined it.
export interface NormalizedConfig {
	registry: NormalizedRegistry;
	roles: Record<string, NormalizedRole>;
	recipes: Record<string, NormalizedRecipe>;
	configPath?: string;
	repoConfigPath?: string;
	provenance?: ConfigProvenance;
}
