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

import type { NormalizedPlan } from "./types.ts";

// The resolved base the approved plan branches from. `ref` is what the operator (or the
// plan) asked to resolve (for display and tamper detection); `sha` is the concrete commit
// the engine launches from, so a moved ref after approval changes the hash.
export interface PlanApprovalBase {
	ref: string;
	sha: string;
}

// The exact thing a confirmed plan start would run: the normalized plan, the resolved base
// commit, and the launch-time per-step iteration budget (when the operator set one). This is
// what the approval hash binds, so nothing that decides the run can change unbound after
// approval. maxIterations is included only when present, so its absence and a present value
// are distinct (and an absent budget keeps the same hash whether the caller omits the field
// or passes undefined).
export interface PlanApprovalArtifact {
	strategy: "plan";
	base: PlanApprovalBase;
	plan: NormalizedPlan;
	maxIterations?: number;
}

export function buildPlanApprovalArtifact(
	plan: NormalizedPlan,
	base: PlanApprovalBase,
	maxIterations?: number,
): PlanApprovalArtifact {
	return {
		strategy: "plan",
		base,
		plan,
		...(maxIterations !== undefined && { maxIterations }),
	};
}

// Deterministic canonical JSON: object keys are sorted at every depth, arrays keep their
// order, primitives serialize as JSON. So two artifacts that differ only in key insertion
// order produce identical bytes -- the hash binds the artifact's VALUE, never the order it
// happened to be built in. undefined-valued keys are dropped (JSON.stringify drops them
// too), so an optional field being absent vs present-as-undefined can never perturb the
// hash.
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = canonicalize(v);
		}
		return out;
	}
	return value;
}

// The exact payload string the CLI/MCP layer hashes to produce a plan's approval hash.
// Stable across key order and equal for equal artifacts (see canonicalize), so the dry-run
// hash and the confirmed-start recompute match iff the normalized plan, base, and budget are
// unchanged.
export function canonicalApprovalPayload(artifact: PlanApprovalArtifact): string {
	return JSON.stringify(canonicalize(artifact));
}
