// MCP handler glue for the plan tools, kept out of the giant server module so the
// plan-runner's public input contract is unit-testable without the MCP wiring. This
// slice covers chit_plan_start input normalization and the gated-apply guard; the
// engine (start/advance/describe/cancel/list) and the real side-effecting deps are
// wired in server.ts.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	buildPlanApprovalArtifact,
	canonicalApprovalPayload,
	type ManifestBinding,
	type NormalizedPlan,
	type PlanApprovalArtifact,
	type PlanApprovalBase,
	type PlanApprovalRecipe,
	PlanError,
	parsePlan,
} from "@chit-run/core";
import { repoToplevel, resolveBaseSha } from "../batches/worktree.ts";
import { normalizeManifestReference } from "../manifest/binding.ts";
import {
	applyPlanStep,
	cleanupPlan,
	describePlan,
	type PlanApplyOutcome,
	type PlanCleanupMode,
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
	// The universal approval gate. confirm omitted/false is a DRY RUN (review only); confirm
	// true launches, and then requires an approvalHash that matches the dry run's.
	confirm?: boolean;
	approvalHash?: string;
}

// A confirmed plan start was refused at the approval gate (missing or non-matching hash).
// It is the caller's own error and carries no local paths, so the handler surfaces it
// verbatim, distinct from a PlanError (a bad plan) and from an engine launch error.
export class PlanApprovalRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanApprovalRefused";
	}
}

// The approval hash for a normalized plan plus resolved base plus launch-time budget: a
// sha256 over the core's canonical payload bytes. The canonical serialization (core) sorts
// keys at every depth, so the hash binds the artifact's VALUE, not the order it was built
// in. Node crypto lives here in the CLI layer, never in @chit-run/core (which stays
// browser-safe and only builds the payload).
export function planApprovalHash(artifact: PlanApprovalArtifact): string {
	return createHash("sha256").update(canonicalApprovalPayload(artifact)).digest("hex");
}

export type PlanStartResult =
	| {
			launched: false;
			strategy: "plan";
			plan: NormalizedPlan;
			base: PlanApprovalBase;
			maxIterations?: number;
			// The resolved manifest binding per step that names a manifestPath or selects a
			// recipe: content digest + safe participant execution summary, bound by the
			// approval hash so the operator reviews the execution surface, not just a path
			// string (or a recipe id).
			manifests?: Record<string, ManifestBinding>;
			// The resolved recipe per recipe-backed step: id, provenance, mode, and runtime
			// defaults, also hash-bound, so the preview shows exactly what every recipe
			// resolved to before approval.
			recipes?: Record<string, PlanApprovalRecipe>;
			approvalHash: string;
	  }
	| { launched: true; view: PlanView; base: PlanApprovalBase; approvalHash: string };

// The chit_plan_start handler core, with the store, engine deps, and id generator injected
// so it is testable without resolving a real repo or spawning the detached converge workers
// the real deps launch. It is universally gated:
//   - confirm omitted/false -> DRY RUN: load + parse the plan, resolve the base ref to a
//     concrete commit, compute the approval hash over { plan, base, maxIterations }, and
//     return launched:false with the normalized plan, base, and hash. It creates NO plan
//     record, worktree, job, or branch -- it only reads git to resolve the base commit,
//     which is part of what the operator approves.
//   - confirm true -> require approvalHash AND that it matches the hash recomputed from THIS
//     call's re-loaded plan and re-resolved base. A missing or stale hash throws
//     PlanApprovalRefused BEFORE any mutation, so a plan, base, or budget changed after
//     approval can never reach execution on an old hash. On a match, launch through the
//     SAME startPlan engine path, pinned to the approved base SHA (not the moving ref) so
//     execution runs exactly the commit that was approved.
export function runPlanStart(
	input: PlanStartInput,
	cwd: string,
	store: PlanStore,
	deps: PlanEngineDeps,
	genId: () => string,
): PlanStartResult {
	const normalizedPlan = loadPlanInput(
		{
			...(input.plan !== undefined && { plan: input.plan }),
			...(input.planPath !== undefined && { planPath: input.planPath }),
		},
		cwd,
	);
	// Resolve the base ref to a concrete commit exactly as startPlan does: the ref the
	// operator (or the plan) names, resolved against the LAUNCHING checkout so a linked-worktree
	// launch pins to that checkout's tip, not the main repo's HEAD. Binding the sha (not just the
	// ref) means a ref that moves between approval and confirmation changes the hash.
	const ref = input.baseBranch ?? normalizedPlan.baseBranch ?? "HEAD";
	const callerCheckout = repoToplevel(deps.git, cwd);
	const sha = resolveBaseSha(deps.git, callerCheckout, ref);
	const base: PlanApprovalBase = { ref, sha };
	// Bind every step's manifest reference (named directly, or resolved through its
	// recipe) to its EFFECTIVE execution surface: content digest (read from the git
	// tree at the approved base for a repo-relative path, the filesystem for an
	// absolute one) + safe participant execution summary, plus the resolved recipe
	// identity and defaults per recipe-backed step. Both the dry run and the confirm
	// pass through here, so an edited manifest, a redefined recipe, or a config change
	// that re-routes participants changes the hash and the confirm refuses.
	const { manifests, recipes } = resolveStepBindings(
		normalizedPlan,
		base.sha,
		callerCheckout,
		cwd,
		deps,
	);
	const artifact = buildPlanApprovalArtifact(
		normalizedPlan,
		base,
		input.maxIterations,
		manifests,
		recipes,
	);
	const hash = planApprovalHash(artifact);

	if (input.confirm !== true) {
		return {
			launched: false,
			strategy: "plan",
			plan: normalizedPlan,
			base,
			...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
			...(manifests !== undefined && { manifests }),
			...(recipes !== undefined && { recipes }),
			approvalHash: hash,
		};
	}

	if (input.approvalHash === undefined || input.approvalHash.length === 0) {
		throw new PlanApprovalRefused(
			"a confirmed plan start requires approval_hash: run chit_plan_start once without confirm " +
				"to review the plan and resolved base, then pass the shown approval_hash back with confirm:true",
		);
	}
	if (input.approvalHash !== hash) {
		throw new PlanApprovalRefused(
			"approval_hash does not match the plan and resolved base: they changed since approval " +
				`(recomputed ${hash}). Re-run chit_plan_start without confirm, review the new plan and base, and pass the new approval_hash.`,
		);
	}

	const view = launchNormalizedPlan(
		{
			normalizedPlan,
			// Pin to the approved COMMIT, not the ref: even if the ref moved after approval, the
			// hash already matched the sha, so the launch runs exactly what was approved.
			baseBranch: base.sha,
			...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
			...(manifests !== undefined && { manifests }),
			...(recipes !== undefined && { recipes }),
		},
		cwd,
		store,
		deps,
		genId,
	);
	return { launched: true, view, base, approvalHash: hash };
}

// Resolve the execution bindings for every step that names a manifestPath or selects
// a recipe, keyed by step id. A direct manifestPath resolves to its manifest binding;
// a recipe resolves to its identity + runtime defaults (recipes record) AND its
// manifest binding (manifests record), so both kinds of step share one binding shape
// for hashing, persistence, and launch-time re-verification. Records are undefined
// when nothing is bound. A reference that cannot be resolved -- an unknown recipe,
// missing from the tree at the approved base, a symlink object, a path escaping the
// repo, bad JSON, an unresolvable participant -- throws PlanError naming the step, so
// a bad plan is refused at the gate exactly like a structural validation failure. A
// recipe-naming plan with no recipe resolver wired is refused too: silently launching
// without the recipe's manifest would run an execution surface nobody reviewed.
function resolveStepBindings(
	plan: NormalizedPlan,
	baseSha: string,
	callerCheckout: string,
	cwd: string,
	deps: PlanEngineDeps,
): {
	manifests?: Record<string, ManifestBinding>;
	recipes?: Record<string, PlanApprovalRecipe>;
} {
	const manifests: Record<string, ManifestBinding> = {};
	const recipes: Record<string, PlanApprovalRecipe> = {};
	for (const step of plan.steps) {
		if (step.recipe !== undefined) {
			if (deps.resolveRecipe === undefined) {
				throw new PlanError(
					`steps.${step.id}.recipe`,
					"recipe resolution is not available in this context; a recipe-backed step cannot be reviewed or launched without resolving the recipe",
				);
			}
			try {
				const resolved = deps.resolveRecipe({
					recipeId: step.recipe,
					baseSha,
					gitCwd: callerCheckout,
					configCwd: cwd,
				});
				manifests[step.id] = resolved.binding;
				recipes[step.id] = {
					id: resolved.id,
					...(resolved.origin !== undefined && { origin: resolved.origin }),
					mode: resolved.mode,
					...(resolved.maxIterations !== undefined && { maxIterations: resolved.maxIterations }),
					...(resolved.callTimeoutMs !== undefined && { callTimeoutMs: resolved.callTimeoutMs }),
					...(resolved.description !== undefined && { description: resolved.description }),
				};
			} catch (e) {
				if (e instanceof PlanError) throw e;
				throw new PlanError(`steps.${step.id}.recipe`, (e as Error).message);
			}
			continue;
		}
		if (step.manifestPath === undefined || deps.resolveManifestBinding === undefined) continue;
		try {
			// Normalize first (rejects repo escapes; relative paths in a plan are repo-root
			// relative, matching where the step worktree later resolves them).
			const ref = normalizeManifestReference(step.manifestPath, callerCheckout, callerCheckout);
			manifests[step.id] = deps.resolveManifestBinding({
				manifestPath: ref.manifestPath,
				baseSha,
				gitCwd: callerCheckout,
				configCwd: cwd,
			});
		} catch (e) {
			throw new PlanError(`steps.${step.id}.manifestPath`, (e as Error).message);
		}
	}
	return {
		...(Object.keys(manifests).length > 0 && { manifests }),
		...(Object.keys(recipes).length > 0 && { recipes }),
	};
}

// Launch an ALREADY-parsed, approved plan through the exact startPlan engine path. runPlanStart
// parses + gates + hashes before this point, so there is no plan JSON to parse here: the
// approved plan is started directly. Keeping this beside runPlanStart keeps the gate and the
// launch in one place and one view.
export function launchNormalizedPlan(
	input: {
		normalizedPlan: NormalizedPlan;
		baseBranch?: string;
		maxIterations?: number;
		manifests?: Record<string, ManifestBinding>;
		recipes?: Record<string, PlanApprovalRecipe>;
	},
	cwd: string,
	store: PlanStore,
	deps: PlanEngineDeps,
	genId: () => string,
): PlanView {
	const started = startPlan(store, deps, {
		// The plan's own id when authored, else a fresh generated one -- both pass the store's guard.
		id: input.normalizedPlan.id ?? genId(),
		cwd,
		normalizedPlan: input.normalizedPlan,
		...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
		...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
		...(input.manifests !== undefined && { manifests: input.manifests }),
		...(input.recipes !== undefined && { recipes: input.recipes }),
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
	input: { planId: string; confirm?: boolean; cleanupMode?: PlanCleanupMode },
	store: PlanStore,
	deps: PlanEngineDeps,
): PlanCleanupResponse {
	const result = cleanupPlan(
		store,
		deps,
		input.planId,
		input.confirm ?? false,
		input.cleanupMode ?? "safe",
	);
	// Re-read so the view reflects cleanedAt (cleanupPlan persisted it on a confirmed run).
	const plan = store.get(input.planId);
	return { ...result, plan: describePlan(plan ?? throwMissing(input.planId), deps) };
}

function throwMissing(planId: string): never {
	throw new PlanError("plan_id", `plan ${JSON.stringify(planId)} vanished during cleanup`);
}
