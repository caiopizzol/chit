// Maps the effective config recipes to the read-only routines view. Recipe
// identity reuses effectiveRecipeViews so redaction and ordering stay shared.

import type { NormalizedConfig } from "@chit-run/core";
import { effectiveRecipeViews } from "./config.ts";
import type {
	DeclaredRoutine,
	DeclaredRoutinesView,
	RoutineLastRunSummary,
	RoutineManifestSummary,
} from "./types.ts";

export interface DeclaredRoutinesResolvers {
	resolveManifest?: (recipeId: string) => RoutineManifestSummary;
	resolveLastRun?: (
		recipeId: string,
		manifest: RoutineManifestSummary | undefined,
	) => RoutineLastRunSummary | undefined;
}

// Manifest enrichment is optional and per recipe, so one missing manifest does not
// hide the rest of the routine menu.
export function declaredRoutinesView(
	config: NormalizedConfig,
	resolvers?: ((recipeId: string) => RoutineManifestSummary) | DeclaredRoutinesResolvers,
): DeclaredRoutinesView {
	const resolveManifest = typeof resolvers === "function" ? resolvers : resolvers?.resolveManifest;
	const resolveLastRun = typeof resolvers === "function" ? undefined : resolvers?.resolveLastRun;
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
		let manifest: RoutineManifestSummary | undefined;
		if (resolveManifest !== undefined) {
			try {
				manifest = resolveManifest(recipe.id);
				routine.manifest = manifest;
			} catch (e) {
				routine.error = (e as Error).message;
			}
		}
		if (resolveLastRun !== undefined) {
			try {
				const lastRun = resolveLastRun(recipe.id, manifest);
				if (lastRun !== undefined) routine.lastRun = lastRun;
			} catch {
				// Last-run evidence is optional. A corrupt old receipt should not make
				// the routine itself look unresolved.
			}
		}
		return routine;
	});
	const view: DeclaredRoutinesView = { routines };
	if (config.configPath !== undefined) view.configPath = config.configPath;
	if (config.repoConfigPath !== undefined) view.repoConfigPath = config.repoConfigPath;
	return view;
}
