// MCP handler glue for the plan tools, kept out of the giant server module so the
// plan-runner's public input contract is unit-testable without the MCP wiring. This
// slice covers chit_plan_start input normalization and the gated-apply guard; the
// engine (start/advance/describe/cancel/list) and the real side-effecting deps are
// wired in server.ts.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type NormalizedPlan, PlanError, parsePlan } from "@chit-run/core";
import { describePlan, type PlanEngineDeps, type PlanView, startPlan } from "./engine.ts";
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

// This slice runs the public chain (start / list / status / advance / cancel) WITHOUT
// the gated apply-then-commit, which is the next slice. chit_plan_advance must never
// silently ignore an apply payload: it rejects it loudly with this message so a caller
// learns the gate is not wired yet rather than assuming their diff was applied.
export const PLAN_APPLY_UNAVAILABLE =
	"gated apply/commit is not available in this build: chit_plan_advance only reconciles a finished step and launches the next runnable one. The apply gate (review a review_ready step's diff, flow it into the integration branch, commit, advance the tip) lands in the next slice. Remove the `apply` payload to advance the chain.";
