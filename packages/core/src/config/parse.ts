// Browser-safe parser for chit's user config (agents + roles + recipes). The
// agents section is delegated to the existing registry parser (built-ins +
// validation); the roles section is parsed here, reusing the manifest's
// session/filesystem vocabulary so a role and a participant validate those fields
// identically. A role's optional default `agent` is checked against the parsed
// registry (built-ins included), so an unknown default agent fails at parse.
// Recipes are vetted manifest references plus safe runtime defaults; they never
// redeclare participants, prompts, checks, or approval policy.
//
// Config is LAYERED: built-ins, then the global config, then the repo config
// (chit.config.json at the repo root). parseConfigLayers is the layering engine;
// parseConfig remains the single-file entry. No node imports: file discovery and
// git-top-level logic live in the CLI's config loader.

import { parseRegistry } from "../agents/registry.ts";
import type { NormalizedRegistry } from "../agents/types.ts";
import { ALLOWED_FILESYSTEM_VALUES, ALLOWED_SESSIONS } from "../manifest/parse.ts";
import type { FilesystemPermission, SessionPolicy } from "../manifest/types.ts";
import {
	ConfigError,
	type ConfigLayerSource,
	type ConfigProvenance,
	type NormalizedConfig,
	type NormalizedConvergeRecipe,
	type NormalizedRecipe,
	type NormalizedRole,
	type RecipeMode,
} from "./types.ts";

const ALLOWED_CONFIG_KEYS = new Set(["agents", "roles", "recipes"]);
const ALLOWED_ROLE_KEYS = new Set(["agent", "instructions", "session", "permissions"]);
const ALLOWED_PERMISSION_KEYS = new Set(["filesystem"]);
// Kebab-case, matching agent ids: lowercase letters/digits/hyphens, starts with a
// letter. A manifest participant references a role by this id.
const ROLE_ID_RE = /^[a-z][a-z0-9-]*$/;
// Recipe surface, deliberately small: a mode, a manifest reference, and safe
// loop defaults for converge recipes. Rejecting everything else loudly IS the recipe trust boundary:
// there is no approval or policy field for a repo config to smuggle in.
const ALLOWED_RECIPE_KEYS = new Set([
	"mode",
	"manifestPath",
	"maxIterations",
	"callTimeoutMs",
	"description",
]);
const ALLOWED_RECIPE_MODES: readonly RecipeMode[] = ["converge", "one-shot"];
// Same id shape as agents and roles.
const RECIPE_ID_RE = /^[a-z][a-z0-9-]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isRecipeMode(v: string): v is RecipeMode {
	return v === "converge" || v === "one-shot";
}

// One config layer to parse: the raw JSON, the file path (for error messages and
// provenance), and which layer it is. Repo layers are untrusted project input.
export interface ConfigLayer {
	raw: unknown;
	path: string;
	source: ConfigLayerSource;
}

// Agent fields a repo config may not set. Both cross the trust boundary between
// "project preference" and "what runs on the operator's machine": env injects
// process environment into agent CLIs; strictMcp loosens MCP isolation. Rejected
// loudly (never silently dropped) so a repo cannot smuggle them in; the global
// config may still use both.
const REPO_FORBIDDEN_AGENT_FIELDS = ["env", "strictMcp"] as const;

function rejectRepoTrustFields(agentsRaw: unknown, configPath: string): void {
	// Shape errors (non-object agents/entries) are parseRegistry's job; this scan
	// only answers "does any agent entry set a trust-boundary field".
	if (!isObject(agentsRaw)) return;
	for (const [id, entry] of Object.entries(agentsRaw)) {
		if (!isObject(entry)) continue;
		for (const field of REPO_FORBIDDEN_AGENT_FIELDS) {
			if (field in entry) {
				throw new ConfigError(
					`${configPath}: agents.${id}.${field}`,
					`"${field}" is not allowed in repo config (trust boundary); set it in the global config instead`,
				);
			}
		}
	}
}

// Layered parse: built-ins, then each layer in order. A later layer replaces a
// user-defined agent, role, or recipe by id as a WHOLE entity (no field merging),
// so the recorded origin fully describes the effective definition. Built-in ids
// stay non-redefinable in every layer (parseRegistry enforces it per layer). A
// layer's roles are validated against the ACCUMULATED registry, so a repo role
// may reference an agent defined in the global config.
export function parseConfigLayers(layers: ConfigLayer[]): NormalizedConfig {
	const registry: NormalizedRegistry = parseRegistry(undefined);
	const provenance: ConfigProvenance = { agents: {}, roles: {}, recipes: {} };
	for (const id of Object.keys(registry.agents)) {
		provenance.agents[id] = { source: "builtin" };
	}
	const roles: Record<string, NormalizedRole> = {};
	const recipes: Record<string, NormalizedRecipe> = {};

	for (const { raw, path, source } of layers) {
		if (raw !== undefined && raw !== null && !isObject(raw)) {
			throw new ConfigError(path, "top-level must be a JSON object");
		}
		const obj = (raw ?? {}) as Record<string, unknown>;
		for (const k of Object.keys(obj)) {
			if (!ALLOWED_CONFIG_KEYS.has(k)) {
				throw new ConfigError(path, `unknown top-level field "${k}"`);
			}
		}

		if (source === "repo") rejectRepoTrustFields(obj.agents, path);

		// Agents (+ built-ins) via the registry parser, per layer. Pass ONLY the
		// agents sub-object so the registry parser never sees `roles` (it rejects
		// unknown top-level keys).
		const layerRegistry = parseRegistry(
			obj.agents === undefined ? undefined : { agents: obj.agents },
			path,
		);
		for (const [id, agent] of Object.entries(layerRegistry.agents)) {
			if (agent.builtIn) continue;
			registry.agents[id] = agent;
			provenance.agents[id] = { source, path };
		}

		if (obj.roles !== undefined) {
			if (!isObject(obj.roles)) {
				throw new ConfigError(`${path}: roles`, "must be a JSON object");
			}
			for (const [id, entry] of Object.entries(obj.roles)) {
				const rolePath = `${path}: roles.${id}`;
				if (!ROLE_ID_RE.test(id)) {
					throw new ConfigError(
						rolePath,
						"role id must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)",
					);
				}
				roles[id] = parseRole(entry, rolePath, registry);
				provenance.roles[id] = { source, path };
			}
		}

		if (obj.recipes !== undefined) {
			if (!isObject(obj.recipes)) {
				throw new ConfigError(`${path}: recipes`, "must be a JSON object");
			}
			for (const [id, entry] of Object.entries(obj.recipes)) {
				const recipePath = `${path}: recipes.${id}`;
				if (!RECIPE_ID_RE.test(id)) {
					throw new ConfigError(
						recipePath,
						"recipe id must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)",
					);
				}
				recipes[id] = parseRecipe(entry, recipePath, source);
				provenance.recipes[id] = { source, path };
			}
		}
	}

	return { registry, roles, recipes, provenance };
}

export function parseConfig(raw: unknown, configPath = "<inline>"): NormalizedConfig {
	return parseConfigLayers(raw === undefined ? [] : [{ raw, path: configPath, source: "global" }]);
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

// Repo recipe manifestPath containment (trust boundary): a repo config is
// untrusted project input, so the manifest it references must live INSIDE the
// repo. The check is purely lexical - reject absolute paths (POSIX and Windows
// forms) and any ".." segment - because a relative path with no ".." segments
// cannot escape whatever repo root it is later resolved against. That is why it
// can live here in browser-safe parse code: no filesystem or repo-root context is
// needed. The global config is operator input and may point anywhere.
function rejectEscapingRepoManifestPath(value: string, path: string): void {
	if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
		throw new ConfigError(
			path,
			"must be repo-relative in repo config (trust boundary); absolute paths are not allowed",
		);
	}
	for (const seg of value.split(/[\\/]/)) {
		if (seg === "..") {
			throw new ConfigError(
				path,
				'may not contain ".." in repo config (trust boundary); the manifest must stay inside the repo',
			);
		}
	}
}

function parseRecipe(raw: unknown, path: string, source: ConfigLayerSource): NormalizedRecipe {
	if (!isObject(raw)) throw new ConfigError(path, "must be a JSON object");
	for (const k of Object.keys(raw)) {
		if (!ALLOWED_RECIPE_KEYS.has(k)) throw new ConfigError(path, `unknown field "${k}"`);
	}

	// mode: required. Anything outside the declared vocabulary fails loudly so a
	// future mode is an explicit addition, never a silent passthrough.
	if (typeof raw.mode !== "string" || !isRecipeMode(raw.mode)) {
		throw new ConfigError(
			`${path}.mode`,
			`must be one of: ${[...ALLOWED_RECIPE_MODES].join(", ")}`,
		);
	}
	const mode = raw.mode;

	if (typeof raw.manifestPath !== "string" || !raw.manifestPath) {
		throw new ConfigError(`${path}.manifestPath`, "must be a non-empty string");
	}
	if (source === "repo") {
		rejectEscapingRepoManifestPath(raw.manifestPath, `${path}.manifestPath`);
	}

	let description: string | undefined;
	if (raw.description !== undefined) {
		if (typeof raw.description !== "string") {
			throw new ConfigError(`${path}.description`, "must be a string");
		}
		description = raw.description;
	}

	if (mode === "one-shot") {
		if (raw.maxIterations !== undefined) {
			throw new ConfigError(`${path}.maxIterations`, "applies only to converge recipes");
		}
		if (raw.callTimeoutMs !== undefined) {
			throw new ConfigError(`${path}.callTimeoutMs`, "applies only to converge recipes");
		}
		return {
			mode,
			manifestPath: raw.manifestPath,
			...(description !== undefined && { description }),
		};
	}

	const recipe: NormalizedConvergeRecipe = { mode, manifestPath: raw.manifestPath };

	if (raw.maxIterations !== undefined) {
		if (
			typeof raw.maxIterations !== "number" ||
			!Number.isInteger(raw.maxIterations) ||
			raw.maxIterations <= 0
		) {
			throw new ConfigError(`${path}.maxIterations`, "must be a positive integer");
		}
		recipe.maxIterations = raw.maxIterations;
	}

	if (raw.callTimeoutMs !== undefined) {
		if (
			typeof raw.callTimeoutMs !== "number" ||
			!Number.isInteger(raw.callTimeoutMs) ||
			raw.callTimeoutMs <= 0
		) {
			throw new ConfigError(`${path}.callTimeoutMs`, "must be a positive integer");
		}
		recipe.callTimeoutMs = raw.callTimeoutMs;
	}

	if (description !== undefined) recipe.description = description;

	return recipe;
}
