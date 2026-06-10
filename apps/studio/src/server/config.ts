// Maps the host's NormalizedConfig to the read-only wire view behind GET
// /api/config. Redaction lives HERE, in one place, so the route stays a thin
// passthrough: env values are reduced to sorted key names (the same convention
// as core's resolveParticipantConfig), strictMcp/passModelOnResume appear only
// for the claude-cli adapter where they mean something, and role instructions
// are collapsed to a bounded preview plus a length so a huge persona never
// crosses the wire by default.

import type {
	ConfigOrigin,
	NormalizedAgent,
	NormalizedConfig,
	NormalizedRecipe,
	NormalizedRole,
} from "@chit-run/core";
import type {
	ConfigOriginSource,
	EffectiveAgentView,
	EffectiveConfigView,
	EffectiveRecipeView,
	EffectiveRoleView,
} from "./types.ts";

// Enough to recognize a persona at a glance without scrolling the panel.
const INSTRUCTIONS_PREVIEW_CHARS = 140;
const CUT_MARKER = "...";

// Layer order for display: built-ins first, then what the user layered on top,
// matching the override direction (repo wins over global wins over builtin).
const ORIGIN_ORDER: Record<ConfigOriginSource, number> = { builtin: 0, global: 1, repo: 2 };

// Whitespace-collapsed, bounded preview. Exported for the unit tests.
export function instructionsPreview(instructions: string): string {
	const collapsed = instructions.replace(/\s+/g, " ").trim();
	if (collapsed.length <= INSTRUCTIONS_PREVIEW_CHARS) return collapsed;
	return `${collapsed
		.slice(0, INSTRUCTIONS_PREVIEW_CHARS - CUT_MARKER.length)
		.trimEnd()}${CUT_MARKER}`;
}

// Provenance is optional on NormalizedConfig; an absent record falls back to
// what the entity itself tells us (builtIn flag for agents, "global" for roles,
// which only user layers can define).
function originOf(
	origin: ConfigOrigin | undefined,
	fallback: ConfigOriginSource,
): ConfigOriginSource {
	return origin?.source ?? fallback;
}

function byOriginThenId(
	a: { origin: ConfigOriginSource; id: string },
	b: { origin: ConfigOriginSource; id: string },
): number {
	return ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin] || a.id.localeCompare(b.id);
}

function agentView(agent: NormalizedAgent, origin: ConfigOriginSource): EffectiveAgentView {
	const view: EffectiveAgentView = { id: agent.id, adapter: agent.adapter, origin };
	if (agent.model !== undefined) view.model = agent.model;
	if (agent.reasoningEffort !== undefined) view.reasoningEffort = agent.reasoningEffort;
	if (agent.adapter === "claude-cli") {
		// Effective on/off: undefined and true both mean strict-on; only an explicit
		// false is off. Same treatment as resolveParticipantConfig.
		view.strictMcp = agent.strictMcp !== false;
		view.passModelOnResume = agent.passModelOnResume;
	}
	if (agent.callTimeoutMs !== undefined) view.callTimeoutMs = agent.callTimeoutMs;
	if (agent.noProgressTimeoutMs !== undefined) view.noProgressTimeoutMs = agent.noProgressTimeoutMs;
	if (agent.description !== undefined) view.description = agent.description;
	if (agent.env !== undefined) {
		const keys = Object.keys(agent.env).sort();
		if (keys.length > 0) view.envKeys = keys;
	}
	return view;
}

function roleView(id: string, role: NormalizedRole, origin: ConfigOriginSource): EffectiveRoleView {
	const view: EffectiveRoleView = {
		id,
		origin,
		session: role.session,
		filesystem: role.permissions.filesystem,
		instructionsPreview: instructionsPreview(role.instructions),
		instructionsLength: role.instructions.length,
	};
	if (role.agent !== undefined) view.agent = role.agent;
	return view;
}

// Field-by-field rebuild (no object spread) so only the contracted fields cross
// the wire: id + origin, the converge mode, the manifest path, and the optional
// loop knobs. Recipes carry no env or instruction bodies, so there is nothing to
// redact here beyond keeping the shape explicit.
function recipeView(
	id: string,
	recipe: NormalizedRecipe,
	origin: ConfigOriginSource,
): EffectiveRecipeView {
	const view: EffectiveRecipeView = {
		id,
		origin,
		mode: recipe.mode,
		manifestPath: recipe.manifestPath,
	};
	if (recipe.maxIterations !== undefined) view.maxIterations = recipe.maxIterations;
	if (recipe.callTimeoutMs !== undefined) view.callTimeoutMs = recipe.callTimeoutMs;
	if (recipe.description !== undefined) view.description = recipe.description;
	return view;
}

export function effectiveConfigView(config: NormalizedConfig): EffectiveConfigView {
	const agents = Object.values(config.registry.agents)
		.map((a) =>
			agentView(a, originOf(config.provenance?.agents[a.id], a.builtIn ? "builtin" : "global")),
		)
		.sort(byOriginThenId);
	const roles = Object.entries(config.roles)
		.map(([id, r]) => roleView(id, r, originOf(config.provenance?.roles[id], "global")))
		.sort(byOriginThenId);
	// Recipes only ever come from a user layer (global/repo), so "global" is the
	// same defensive fallback roles use when provenance is somehow absent.
	const recipes = Object.entries(config.recipes)
		.map(([id, r]) => recipeView(id, r, originOf(config.provenance?.recipes[id], "global")))
		.sort(byOriginThenId);
	const view: EffectiveConfigView = { agents, roles, recipes };
	if (config.configPath !== undefined) view.configPath = config.configPath;
	if (config.repoConfigPath !== undefined) view.repoConfigPath = config.repoConfigPath;
	return view;
}
