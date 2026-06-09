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

// A vetted execution profile: a CLOSED menu entry an operator (or a planner draft)
// selects by id to say "run this work the vetted way." A profile is the ONLY place a
// manifest path is chosen for planner-authored work: a draft picks a profileId, it
// never synthesizes a manifestPath, permissions, model, adapter, or agent config.
// `manifestPath` undefined means the bundled default converge manifest (today's
// behavior). maxIterations / callTimeoutMs are optional vetted defaults the compiler
// injects when a draft step does not override them.
export interface NormalizedProfile {
	id: string;
	manifestPath?: string;
	maxIterations?: number;
	callTimeoutMs?: number;
	// True for the built-in `default` profile; false for a profile from config.json.
	builtIn: boolean;
}

// The id of the built-in profile that preserves today's bundled default converge
// behavior: no manifestPath (the bundled default), no iteration/timeout overrides
// (the driver defaults apply). Always present in NormalizedConfig.profiles and not
// redefinable by user config.
export const DEFAULT_PROFILE_ID = "default";

// The whole config: the agent registry (built-ins merged with the file's agents),
// the named roles, and the execution profiles (the built-in default merged with the
// file's profiles). `roles` is empty when the file declares none; `profiles` always
// contains at least the built-in `default`.
export interface NormalizedConfig {
	registry: NormalizedRegistry;
	roles: Record<string, NormalizedRole>;
	profiles: Record<string, NormalizedProfile>;
	configPath?: string;
}
