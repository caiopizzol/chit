// The structural approval binding for a planner draft. A draft is previewed, a human
// reviews it, and then a confirmed launch must run EXACTLY what was reviewed -- nothing
// edited in between. To bind the approval to the work, we hash the COMPILED execution
// artifact (the strategy plus the exact compiled plan or batch task list a launch feeds
// to the engine), not the compact human preview: the preview omits prompts and config
// internals, so two materially different drafts can share one preview, but never one
// compiled artifact. The dry-run shows the hash; the confirmed launch re-parses,
// re-compiles, recomputes the hash, and refuses if it differs from the one the operator
// approved -- so a draft changed after approval cannot ride an old hash into execution.
//
// This module is browser-safe (no node imports). It builds the canonical PAYLOAD only;
// the actual digest is computed in the CLI/MCP layer (node crypto), keeping core free of
// node dependencies. canonicalApprovalPayload(artifact) is the exact bytes that layer
// hashes, so a Studio preview and the MCP tool derive the identical hash from the
// identical artifact.

import type { NormalizedProfile } from "../config/types.ts";
import type { NormalizedPlan } from "../plan/types.ts";
import { type CompiledBatchTask, compileBatchDraft, compilePlanDraft } from "./compile.ts";
import type { DraftStrategy, PlannerDraft } from "./types.ts";

// The compiled execution artifact a launch would run: the strategy plus the exact shape
// the engine receives. Exactly one of plan/batch is present, matching `strategy`. This is
// what the approval hash binds -- the compiled plan/task list, including the profile's
// injected manifestPath and budgets, so the hash covers everything that decides the run.
export type CompiledArtifact =
	| { strategy: "plan"; plan: NormalizedPlan }
	| { strategy: "batch"; batch: CompiledBatchTask[] };

// Compile a validated draft into the artifact a launch would execute. Runs the SAME pure
// compilers (compile.ts) as preview and launch, so every validation a launch enforces
// (unknown profile, plan-only manifestPath, batch codeDependsOn, missing/traversal
// claims, cycles) fails here too. Throws a DraftError when the draft cannot be honored;
// never mutates the draft or the profile menu.
export function compileDraftArtifact(
	draft: PlannerDraft,
	profiles: Record<string, NormalizedProfile>,
): CompiledArtifact {
	if (draft.strategy === "plan") {
		return { strategy: "plan", plan: compilePlanDraft(draft, profiles) };
	}
	return { strategy: "batch", batch: compileBatchDraft(draft, profiles) };
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

// The exact payload string the CLI/MCP layer hashes to produce a draft's approval hash.
// Stable across key order and equal for equal artifacts (see canonicalize), so the dry-run
// hash and the confirmed-launch recompute match iff the compiled artifact is unchanged.
export function canonicalApprovalPayload(artifact: CompiledArtifact): string {
	return JSON.stringify(canonicalize(artifact));
}

// Compile a draft and return its canonical approval payload in one step, the common path
// for a caller that just needs the bytes to hash. `strategy` is surfaced so the caller can
// route the launch (plan vs batch) without re-inspecting the draft.
export function draftApprovalPayload(
	draft: PlannerDraft,
	profiles: Record<string, NormalizedProfile>,
): { strategy: DraftStrategy; artifact: CompiledArtifact; payload: string } {
	const artifact = compileDraftArtifact(draft, profiles);
	return { strategy: artifact.strategy, artifact, payload: canonicalApprovalPayload(artifact) };
}
