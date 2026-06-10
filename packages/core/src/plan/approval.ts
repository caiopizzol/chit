// The structural approval binding for a native sequential plan. chit_plan_start runs a
// dry run first: it parses the plan, resolves the base ref to a concrete commit, and
// returns an approval hash. A human reviews exactly that, and then a confirmed start must
// run EXACTLY what was reviewed: the normalized plan, the per-step iteration budget, and
// the base commit it branches from. To bind the approval to the work, we hash the
// NORMALIZED plan plus the resolved base commit plus the launch-time maxIterations, so a
// plan, base, or budget changed after approval cannot ride an old hash into execution: the
// confirmed start re-parses, re-resolves the base, recomputes the hash, and refuses if it
// differs from the one the operator approved.
//
// This module is browser-safe (no node imports). It builds the canonical PAYLOAD only; the
// actual digest is computed in the CLI/MCP layer (node crypto), keeping core free of node
// dependencies. canonicalApprovalPayload(artifact) is the exact bytes that layer hashes, so
// every caller derives the identical hash from the identical approval artifact.

import { canonicalJson } from "../canonical-json.ts";
import type { RecipeReceipt } from "../config/types.ts";
import type { ManifestBinding } from "../manifest/binding.ts";
import type { NormalizedPlan } from "./types.ts";

// The resolved base the approved plan branches from. `ref` is what the operator (or the
// plan) asked to resolve (for display and tamper detection); `sha` is the concrete commit
// the engine launches from, so a moved ref after approval changes the hash.
export interface PlanApprovalBase {
	ref: string;
	sha: string;
}

// The resolved identity and runtime defaults of the config recipe a step selected,
// bound per step id so a recipe redefined after approval (a different id meaning, a
// changed default budget, a moved provenance layer) moves the hash and forces
// re-approval. The recipe's resolved MANIFEST surface (path, source, content digest,
// participant summary) is bound through the same per-step `manifests` record direct
// manifestPath steps use -- a recipe is a reference to a manifest, never a second
// execution vocabulary, so it must not grow a second binding shape either.
export interface PlanApprovalRecipe extends RecipeReceipt {}

// The exact thing a confirmed plan start would run: the normalized plan, the resolved base
// commit, and the launch-time per-step iteration budget (when the operator set one). This is
// what the approval hash binds, so nothing that decides the run can change unbound after
// approval. maxIterations is included only when present, so its absence and a present value
// are distinct (and an absent budget keeps the same hash whether the caller omits the field
// or passes undefined).
// manifests binds, per step id, the EFFECTIVE execution surface of every step that
// names a manifestPath or resolves one through a recipe: the manifest content digest
// (read from the git tree at the approved base for a repo-relative path, or from the
// filesystem for an absolute one) plus the safe participant execution summary.
// Binding only the path string would let the file content or the resolved agents
// change between approval and launch without moving the hash. Present only when at
// least one step binds a manifest, so manifest-free plans keep their hash.
// recipes binds, per step id, the resolved recipe identity and its runtime defaults
// for every recipe-backed step; together with the step's own hash-bound overrides in
// `plan`, the EFFECTIVE budgets a launch computes are fully approval-bound.
export interface PlanApprovalArtifact {
	strategy: "plan";
	base: PlanApprovalBase;
	plan: NormalizedPlan;
	maxIterations?: number;
	manifests?: Record<string, ManifestBinding>;
	recipes?: Record<string, PlanApprovalRecipe>;
}

export function buildPlanApprovalArtifact(
	plan: NormalizedPlan,
	base: PlanApprovalBase,
	maxIterations?: number,
	manifests?: Record<string, ManifestBinding>,
	recipes?: Record<string, PlanApprovalRecipe>,
): PlanApprovalArtifact {
	return {
		strategy: "plan",
		base,
		plan,
		...(maxIterations !== undefined && { maxIterations }),
		...(manifests !== undefined && Object.keys(manifests).length > 0 && { manifests }),
		...(recipes !== undefined && Object.keys(recipes).length > 0 && { recipes }),
	};
}

// The exact payload string the CLI/MCP layer hashes to produce a plan's approval hash.
// Stable across key order and equal for equal artifacts (see canonicalJson), so the dry-run
// hash and the confirmed-start recompute match iff the normalized plan, base, and budget are
// unchanged.
export function canonicalApprovalPayload(artifact: PlanApprovalArtifact): string {
	return canonicalJson(artifact);
}
