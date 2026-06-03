// Browser-safe parser for chit's user config (agents + roles). The agents section
// is delegated to the existing registry parser (built-ins + validation); the roles
// section is parsed here, reusing the manifest's session/filesystem vocabulary so a
// role and a participant validate those fields identically. A role's optional
// default `agent` is checked against the parsed registry (built-ins included), so an
// unknown default agent fails at parse. No node imports: file loading lives in the
// CLI's config loader.

import { parseRegistry } from "../agents/registry.ts";
import type { NormalizedRegistry } from "../agents/types.ts";
import { ALLOWED_FILESYSTEM_VALUES, ALLOWED_SESSIONS } from "../manifest/parse.ts";
import type { FilesystemPermission, SessionPolicy } from "../manifest/types.ts";
import { ConfigError, type NormalizedConfig, type NormalizedRole } from "./types.ts";

const ALLOWED_CONFIG_KEYS = new Set(["agents", "roles"]);
const ALLOWED_ROLE_KEYS = new Set(["agent", "instructions", "session", "permissions"]);
const ALLOWED_PERMISSION_KEYS = new Set(["filesystem"]);
// Kebab-case, matching agent ids: lowercase letters/digits/hyphens, starts with a
// letter. A manifest participant references a role by this id.
const ROLE_ID_RE = /^[a-z][a-z0-9-]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseConfig(raw: unknown, configPath = "<inline>"): NormalizedConfig {
	if (raw !== undefined && raw !== null && !isObject(raw)) {
		throw new ConfigError(configPath, "top-level must be a JSON object");
	}
	const obj = (raw ?? {}) as Record<string, unknown>;
	for (const k of Object.keys(obj)) {
		if (!ALLOWED_CONFIG_KEYS.has(k)) {
			throw new ConfigError(configPath, `unknown top-level field "${k}"`);
		}
	}

	// Agents (+ built-ins) via the registry parser. Pass ONLY the agents sub-object
	// so the registry parser never sees `roles` (it rejects unknown top-level keys).
	const registry: NormalizedRegistry = parseRegistry(
		obj.agents === undefined ? undefined : { agents: obj.agents },
		configPath,
	);

	const roles: Record<string, NormalizedRole> = {};
	if (obj.roles !== undefined) {
		if (!isObject(obj.roles)) {
			throw new ConfigError(`${configPath}: roles`, "must be a JSON object");
		}
		for (const [id, entry] of Object.entries(obj.roles)) {
			const path = `${configPath}: roles.${id}`;
			if (!ROLE_ID_RE.test(id)) {
				throw new ConfigError(
					path,
					"role id must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)",
				);
			}
			roles[id] = parseRole(entry, path, registry);
		}
	}

	return { registry, roles };
}

function parseRole(raw: unknown, path: string, registry: NormalizedRegistry): NormalizedRole {
	if (!isObject(raw)) throw new ConfigError(path, "must be a JSON object");
	for (const k of Object.keys(raw)) {
		if (!ALLOWED_ROLE_KEYS.has(k)) throw new ConfigError(path, `unknown field "${k}"`);
	}

	// instructions: the persona. Required, non-empty (same rule as a participant).
	if (typeof raw.instructions !== "string" || !raw.instructions) {
		throw new ConfigError(`${path}.instructions`, "must be a non-empty string");
	}

	// session: required, same vocabulary as a participant.
	if (typeof raw.session !== "string" || !ALLOWED_SESSIONS.has(raw.session)) {
		throw new ConfigError(`${path}.session`, `must be one of: ${[...ALLOWED_SESSIONS].join(", ")}`);
	}

	// permissions: optional, defaults read_only (same as a participant).
	let filesystem: FilesystemPermission = "read_only";
	if ("permissions" in raw) {
		const perms = raw.permissions;
		if (!isObject(perms)) throw new ConfigError(`${path}.permissions`, "must be an object");
		for (const k of Object.keys(perms)) {
			if (!ALLOWED_PERMISSION_KEYS.has(k)) {
				throw new ConfigError(`${path}.permissions`, `unknown field "${k}"`);
			}
		}
		if ("filesystem" in perms) {
			if (
				typeof perms.filesystem !== "string" ||
				!ALLOWED_FILESYSTEM_VALUES.has(perms.filesystem)
			) {
				throw new ConfigError(
					`${path}.permissions.filesystem`,
					`must be one of: ${[...ALLOWED_FILESYSTEM_VALUES].join(", ")}`,
				);
			}
			filesystem = perms.filesystem as FilesystemPermission;
		}
	}

	const role: NormalizedRole = {
		instructions: raw.instructions,
		session: raw.session as SessionPolicy,
		permissions: { filesystem },
	};

	// agent: OPTIONAL default. When present it must be a non-empty string AND resolve
	// in the registry (built-ins included), so an unknown default agent fails here.
	// A model-agnostic role (no agent) is valid; the participant must then supply one.
	if (raw.agent !== undefined) {
		if (typeof raw.agent !== "string" || !raw.agent) {
			throw new ConfigError(`${path}.agent`, "must be a non-empty string when present");
		}
		if (!(raw.agent in registry.agents)) {
			throw new ConfigError(`${path}.agent`, `unknown agent "${raw.agent}" (not in the registry)`);
		}
		role.agent = raw.agent;
	}

	return role;
}
