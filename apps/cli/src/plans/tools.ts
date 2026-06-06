// MCP handler glue for the plan tools, kept out of the giant server module so the
// plan-runner's public input contract is unit-testable without the MCP wiring. This
// slice covers chit_plan_start input normalization and the gated-apply guard; the
// engine (start/advance/describe/cancel/list) and the real side-effecting deps are
// wired in server.ts.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type NormalizedPlan, PlanError, parsePlan } from "@chit-run/core";
import {
	applyPlanStep,
	cleanupPlan,
	describePlan,
	type PlanApplyOutcome,
	type PlanCleanupResult,
	type PlanEngineDeps,
	type PlanView,
	startPlan,
} from "./engine.ts";
import type { PlanStore } from "./store.ts";

// Resolve a chit_plan_start input into a normalized plan. Exactly one of `plan` (an
// inline plan object, or a JSON string) or `planPath` (a file read relative to cwd)
// must be given. A read / JSON failure surfaces as PlanError so the handler reports it
// the same way as a structural validation failure (one error channel, no path leaks
// beyond the one the caller named).
export function loadPlanInput(
	input: { plan?: string | Record<string, unknown>; planPath?: string },
	cwd: string,
): NormalizedPlan {
	const hasInline = input.plan !== undefined;
	const hasPath = input.planPath !== undefined;
	if (hasInline === hasPath) {
		throw new PlanError("$", "provide exactly one of `plan` or `plan_path`");
	}

	let raw: unknown;
	if (hasPath) {
		const p = input.planPath as string;
		const abs = isAbsolute(p) ? p : resolve(cwd, p);
		if (!existsSync(abs)) throw new PlanError("plan_path", `no plan file at ${abs}`);
		let text: string;
		try {
			text = readFileSync(abs, "utf-8");
		} catch (e) {
			throw new PlanError("plan_path", `could not read ${abs}: ${(e as Error).message}`);
		}
		raw = parseJson(text, "plan_path");
	} else if (typeof input.plan === "string") {
		raw = parseJson(input.plan, "plan");
	} else {
		raw = input.plan;
	}
	return parsePlan(raw);
}

function parseJson(text: string, path: string): unknown {
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new PlanError(path, `invalid JSON: ${(e as Error).message}`);
	}
}

export interface PlanStartInput {
	plan?: string | Record<string, unknown>;
	planPath?: string;
	baseBranch?: string;
	maxIterations?: number;
}

// The chit_plan_start handler core, with the store, engine deps, and id generator
// injected so it is testable without resolving a real repo or spawning the detached
// converge workers the real deps launch. Normalizes the input, picks the plan id (the
// plan's own when authored, else a generated one), starts the plan, and returns the
// public view (which leads with plan_id). The MCP handler in server.ts only adds the
// real PlanStore / PlanEngineDeps and the cwd/repo resolution around this.
export function runPlanStart(
	input: PlanStartInput,
	cwd: string,
	store: PlanStore,
	deps: PlanEngineDeps,
	genId: () => string,
): PlanView {
	const normalizedPlan = loadPlanInput(
		{
			...(input.plan !== undefined && { plan: input.plan }),
			...(input.planPath !== undefined && { planPath: input.planPath }),
		},
		cwd,
	);
	const started = startPlan(store, deps, {
		// The plan's own id when authored, else a fresh generated one -- both pass the store's guard.
		id: normalizedPlan.id ?? genId(),
		cwd,
		normalizedPlan,
		...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
		...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
	});
	return describePlan(started, deps);
}

// The chit_plan_advance apply-payload glue: run the gated apply (review_ready step -> integration
// branch) and return the apply detail WITH the refreshed plan view. The apply gate is its own
// progression trigger: it does NOT also reconcile/launch (a subsequent plain advance launches the
// next step from the advanced tip), so the operator gate stays explicit. The view leads the
// response so an agent following nextAction sees the new state.
export interface PlanApplyResponse extends Omit<PlanApplyOutcome, "plan"> {
	plan: PlanView;
}

export function runPlanApply(
	input: { planId: string; stepId: string; confirm?: boolean; includeUntracked?: string[] },
	store: PlanStore,
	deps: PlanEngineDeps,
): PlanApplyResponse {
	const outcome = applyPlanStep(store, deps, {
		planId: input.planId,
		stepId: input.stepId,
		confirm: input.confirm ?? false,
		...(input.includeUntracked !== undefined && { includeUntracked: input.includeUntracked }),
	});
	const { plan, ...rest } = outcome;
	return { ...rest, plan: describePlan(plan, deps) };
}

// The chit_plan_cleanup glue: retire the plan's managed worktrees + branches (dry-run by default)
// and return the cleanup result WITH the refreshed plan view (which now carries cleanedAt on a
// confirmed run). Durable records are always kept; the engine enforces the terminal-plan rule.
export interface PlanCleanupResponse extends PlanCleanupResult {
	plan: PlanView;
}

export function runPlanCleanup(
	input: { planId: string; confirm?: boolean },
	store: PlanStore,
	deps: PlanEngineDeps,
): PlanCleanupResponse {
	const result = cleanupPlan(store, deps, input.planId, input.confirm ?? false);
	// Re-read so the view reflects cleanedAt (cleanupPlan persisted it on a confirmed run).
	const plan = store.get(input.planId);
	return { ...result, plan: describePlan(plan ?? throwMissing(input.planId), deps) };
}

function throwMissing(planId: string): never {
	throw new PlanError("plan_id", `plan ${JSON.stringify(planId)} vanished during cleanup`);
}
