// Maps the effective config recipes to the read-only routines view. Recipe
// identity reuses effectiveRecipeViews so redaction and ordering stay shared.

import type { NormalizedConfig } from "@chit-run/core";
import { effectiveRecipeViews } from "./config.ts";
import type { DeclaredRoutine, DeclaredRoutinesView, RoutineManifestSummary } from "./types.ts";

// Manifest enrichment is optional and per recipe, so one missing manifest does not
// hide the rest of the routine menu.
export function declaredRoutinesView(
	config: NormalizedConfig,
	resolveManifest?: (recipeId: string) => RoutineManifestSummary,
): DeclaredRoutinesView {
	const routines: DeclaredRoutine[] = effectiveRecipeViews(config).map((recipe) => {
		const routine: DeclaredRoutine = {
			id: recipe.id,
			origin: recipe.origin,
			mode: recipe.mode,
			manifestPath: recipe.manifestPath,
		};
		if (recipe.maxIterations !== undefined) routine.maxIterations = recipe.maxIterations;
		if (recipe.callTimeoutMs !== undefined) routine.callTimeoutMs = recipe.callTimeoutMs;
		if (recipe.description !== undefined) routine.description = recipe.description;
		if (resolveManifest !== undefined) {
			try {
				routine.manifest = resolveManifest(recipe.id);
			} catch (e) {
				routine.error = (e as Error).message;
			}
		}
		return routine;
	});
	const view: DeclaredRoutinesView = { routines };
	if (config.configPath !== undefined) view.configPath = config.configPath;
	if (config.repoConfigPath !== undefined) view.repoConfigPath = config.repoConfigPath;
	return view;
}
