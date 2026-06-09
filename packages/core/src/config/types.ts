import type { NormalizedRegistry } from "../agents/types.ts";
import type { FilesystemPermission, SessionPolicy } from "../manifest/types.ts";

// chit's user config: agents (model profiles) + roles (reusable behavior +
// governance), in one file (~/.config/chit/config.json). Parsed in core (this
// module is browser-safe: structure validation, no node:fs); the node-side loader
// reads the file. A manifest does NOT live here; a manifest's participants
// reference these roles, and resolution (registry + roles aware) happens at the
// run boundary, not in manifest parse.

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

export interface ConfigProvenance {
	agents: Record<string, ConfigOrigin>;
	roles: Record<string, ConfigOrigin>;
}

// The whole config: the agent registry (built-ins merged with the file's agents),
// and the named roles. `roles` is empty when the file declares none. configPath /
// repoConfigPath are the global and repo files that were actually read; provenance
// records, per effective agent and role, which layer defined it.
export interface NormalizedConfig {
	registry: NormalizedRegistry;
	roles: Record<string, NormalizedRole>;
	configPath?: string;
	repoConfigPath?: string;
	provenance?: ConfigProvenance;
}
