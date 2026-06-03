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

// The whole config: the agent registry (built-ins merged with the file's agents)
// plus the named roles. `roles` is empty when the file declares none.
export interface NormalizedConfig {
	registry: NormalizedRegistry;
	roles: Record<string, NormalizedRole>;
	configPath?: string;
}
