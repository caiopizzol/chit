// The native orchestrator entrypoint: turn a software goal into a REVIEWABLE plan a
// human can approve, by composing primitives that already exist -- nothing here runs a
// step, merges a branch, or decides routing. It runs the bundled planner manifest
// (examples/plan-author.json) through an injected planner runner, parses + validates the
// planner's JSON output into a plan, and dry-runs the existing runPlanStart path to
// resolve the base, the recipes, the manifest bindings, and the approval hash the
// operator must echo back to launch. The dry run is asserted NOT to launch: orchestrate
// never confirms a start, so it can create no plan record, worktree, job, or branch.
//
// Deliberately NOT here (out of scope by design): a workflow engine, a scheduler,
// auto-approval, or any model-decided routing. The output is a plan + an approval hash;
// a human runs chit_plan_start with confirm:true to act on it.

import { join } from "node:path";
import {
	type ManifestBinding,
	type NormalizedPlan,
	type PlanApprovalBase,
	type PlanApprovalRecipe,
	PlanError,
	parsePlan,
} from "@chit-run/core";
import type { PlanStartResult } from "../../plans/tools.ts";

// The bundled planner manifest's canonical-example path, resolved relative to this module so
// it points at the curated example in the source tree (examples/plan-author.json), not a caller
// path. It is the manifest IDENTITY the injected runner receives; the production runner runs the
// embedded twin (DEFAULT_PLAN_AUTHOR_MANIFEST, drift-guarded against this file) rather than
// reading it, so the tool works from the published binary, which ships no examples/.
export const PLAN_AUTHOR_MANIFEST_PATH = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"..",
	"examples",
	"plan-author.json",
);

// A planner step or its plan output could not be turned into a reviewable plan: the
// planner returned non-JSON, or JSON that is not a structurally valid plan. It is the
// orchestrator's own error channel, distinct from a downstream dry-run/git failure, so
// the caller can tell "the planner produced something unusable" from "resolving the base
// failed". Carries no local paths.
export class OrchestrateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrchestrateError";
	}
}

export interface PlannerRunArgs {
	// The bundled planner manifest's identity (PLAN_AUTHOR_MANIFEST_PATH). The production runner
	// runs the embedded twin keyed by this identity; a test runner keys its canned reply off it.
	manifestPath: string;
	goal: string;
	context?: string;
	// The repo the planner inspects to ground its steps.
	cwd: string;
}

export interface OrchestrateDeps {
	// Run the bundled planner manifest with the given inputs and return its raw output:
	// the plan JSON text the planning agent emits. The production binding executes the
	// manifest; tests inject a fake that returns canned text.
	runPlanner(args: PlannerRunArgs): string | Promise<string>;
	// Dry-run a parsed plan through the existing runPlanStart path (confirm deliberately
	// omitted, so it only reads git to resolve the base + bindings and creates nothing).
	// The production binding closes over the plan store, engine deps, and id generator;
	// tests inject a fake returning a canned PlanStartResult.
	dryRunPlan(
		input: { plan: Record<string, unknown>; baseBranch?: string; maxIterations?: number },
		cwd: string,
	): PlanStartResult;
}

export interface OrchestrateInput {
	goal: string;
	context?: string;
	baseBranch?: string;
	// The per-step iteration budget for a step that declares none, threaded into the dry run
	// so the previewed approval hash binds it -- the operator's confirm must echo the same value.
	maxIterations?: number;
	cwd: string;
}

export interface OrchestrateResult {
	// The normalized, structurally-valid plan ready for chit_plan_start.
	plan: NormalizedPlan;
	// The base ref resolved to a concrete commit by the dry run (what the hash binds).
	base: PlanApprovalBase;
	// The approval hash the operator echoes back with confirm:true to launch the plan.
	approvalHash: string;
	// Per recipe-backed step: the resolved recipe identity + defaults, when any step uses one.
	recipes?: Record<string, PlanApprovalRecipe>;
	// Per step that names a manifest (directly or via a recipe): the resolved binding, when any.
	manifests?: Record<string, ManifestBinding>;
	// Plain-language instructions for the human's next move (review, then confirm).
	nextSteps: string;
}

// Compose the planning primitives into one reviewable result. Steps, in order:
//   1. run the bundled planner manifest through the injected runner -> raw plan text;
//   2. parse it as JSON (a non-JSON planner reply is an OrchestrateError, not a crash);
//   3. validate it with parsePlan (an invalid plan is an OrchestrateError naming the path);
//   4. dry-run the existing runPlanStart path to resolve base + recipes + manifests + hash;
//   5. assert the dry run did NOT launch (orchestrate never confirms a start);
//   6. return the normalized plan, resolved base, hash, recipes, manifests, and next steps.
export async function runOrchestrate(
	input: OrchestrateInput,
	deps: OrchestrateDeps,
): Promise<OrchestrateResult> {
	const planText = await deps.runPlanner({
		manifestPath: PLAN_AUTHOR_MANIFEST_PATH,
		goal: input.goal,
		...(input.context !== undefined && { context: input.context }),
		cwd: input.cwd,
	});

	let parsed: unknown;
	try {
		parsed = JSON.parse(planText);
	} catch (e) {
		throw new OrchestrateError(`the planner did not return valid JSON: ${(e as Error).message}`);
	}

	// Validate the planner's output is a usable plan before touching git in the dry run,
	// so a bad plan surfaces as one clean error rather than a base-resolution failure.
	let plan: NormalizedPlan;
	try {
		plan = parsePlan(parsed);
	} catch (e) {
		if (e instanceof PlanError) {
			throw new OrchestrateError(`the planner produced an invalid plan -- ${e.message}`);
		}
		throw e;
	}

	// Dry-run the existing runPlanStart path. parsed is the plan object the operator would
	// re-submit to chit_plan_start; runPlanStart re-parses it and resolves the base, recipes,
	// manifest bindings, and approval hash. confirm is never passed, so nothing is launched.
	const dry = deps.dryRunPlan(
		{
			plan: parsed as Record<string, unknown>,
			...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
			...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
		},
		input.cwd,
	);

	// Orchestrate must never confirm a start, so the dry run cannot have launched. A
	// launched result means the dry-run dependency was wired wrong (confirm leaked in);
	// refuse loudly rather than report a phantom plan with no record behind it.
	if (dry.launched) {
		throw new OrchestrateError(
			"orchestrate dry run unexpectedly launched a plan; it must only preview, never confirm a start",
		);
	}

	// When the caller overrode the base or the per-step iteration budget, the dry run hashed
	// against THOSE values, so the confirm must repeat them -- otherwise chit_plan_start
	// re-resolves the plan's own base (or HEAD) / default budget, recomputes a different hash,
	// and refuses the start. Name them explicitly so following nextSteps verbatim confirms
	// against exactly what was previewed.
	const echoes = [
		input.baseBranch !== undefined ? `base_branch:${input.baseBranch}` : undefined,
		input.maxIterations !== undefined ? `max_iterations:${input.maxIterations}` : undefined,
	].filter((v): v is string => v !== undefined);
	const baseClause =
		echoes.length > 0 ? `, and ${echoes.join(", ")} (the same values this dry run used)` : "";

	return {
		plan,
		base: dry.base,
		approvalHash: dry.approvalHash,
		...(dry.recipes !== undefined && { recipes: dry.recipes }),
		...(dry.manifests !== undefined && { manifests: dry.manifests }),
		nextSteps:
			"This is a dry run: nothing was launched and no plan record, worktree, job, or branch was created. " +
			"Review the plan, the resolved base, any resolved recipes, and any resolved manifest bindings above, " +
			`then call chit_plan_start with this exact plan, confirm:true, approval_hash:${dry.approvalHash}${baseClause}. ` +
			"Editing the plan, base, a referenced manifest's content, a selected recipe's definition, or the config " +
			"that resolves its participants changes the hash and the start is refused.",
	};
}
