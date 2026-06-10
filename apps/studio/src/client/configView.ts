// Pure helpers for the read-only config panel, kept out of the component so the
// display logic is unit-testable without React. Grouping by origin is what lets
// the panel say "builtin / global / repo" ONCE per group instead of stamping a
// label on every row; the meta lines show only deviations from defaults so the
// common case stays one quiet line per entry.

import type {
	ConfigOriginSource,
	EffectiveAgentView,
	EffectiveRecipeView,
	EffectiveRoleView,
} from "../server/types.ts";

const ORIGIN_ORDER: ConfigOriginSource[] = ["builtin", "global", "repo"];

export interface OriginGroup<T> {
	origin: ConfigOriginSource;
	items: T[];
}

// Group entries by origin in layer order, skipping empty groups. Input order
// within a group is preserved (the server already sorts by origin then id).
export function groupByOrigin<T extends { origin: ConfigOriginSource }>(
	items: T[],
): Array<OriginGroup<T>> {
	return ORIGIN_ORDER.map((origin) => ({
		origin,
		items: items.filter((i) => i.origin === origin),
	})).filter((g) => g.items.length > 0);
}

// Compact duration for the timeout fields: whole minutes when even, else seconds.
export function formatTimeout(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${Math.round(ms / 1000)}s`;
}

// One quiet meta line per agent: the pinned model (or the adapter default),
// then only the settings that deviate from defaults. strictMcp default-on and
// passModelOnResume default-off stay silent, so a builtin agent reads as just
// "default model".
export function agentMeta(agent: EffectiveAgentView): string {
	const parts: string[] = [agent.model ?? "default model"];
	if (agent.reasoningEffort !== undefined) parts.push(`effort ${agent.reasoningEffort}`);
	if (agent.callTimeoutMs !== undefined) parts.push(`call ${formatTimeout(agent.callTimeoutMs)}`);
	if (agent.noProgressTimeoutMs !== undefined) {
		parts.push(`no-progress ${formatTimeout(agent.noProgressTimeoutMs)}`);
	}
	if (agent.strictMcp === false) parts.push("strictMcp off");
	if (agent.passModelOnResume === true) parts.push("pass model on resume");
	if (agent.envKeys !== undefined && agent.envKeys.length > 0) {
		parts.push(`env ${agent.envKeys.join(", ")}`);
	}
	return parts.join(" · ");
}

// One meta line per role: default agent (or "any agent"), session, filesystem.
export function roleMeta(role: EffectiveRoleView): string {
	return [role.agent ?? "any agent", role.session, role.filesystem].join(" · ");
}

// One compact meta line per recipe: the mode and the manifest it runs, then the
// loop knobs only when set. The mode and path are self-describing, so no labels
// are stamped on them; max iterations and call timeout get a short prefix so the
// numbers read unambiguously. callTimeoutMs reuses formatTimeout (the same unit
// the agent lines use).
export function recipeMeta(recipe: EffectiveRecipeView): string {
	const parts: string[] = [recipe.mode, recipe.manifestPath];
	if (recipe.maxIterations !== undefined) parts.push(`max ${recipe.maxIterations}`);
	if (recipe.callTimeoutMs !== undefined) parts.push(`call ${formatTimeout(recipe.callTimeoutMs)}`);
	return parts.join(" · ");
}

// The instructions footnote: the bounded preview plus a length hint when the
// preview is a cut (so "..." reads as "there is more", quantified).
export function instructionsNote(role: EffectiveRoleView): string {
	if (role.instructionsPreview.length >= role.instructionsLength) {
		return role.instructionsPreview;
	}
	return `${role.instructionsPreview} (${role.instructionsLength} chars)`;
}
