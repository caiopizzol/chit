// The planner-authored execution draft: a declared artifact that proposes HOW chit
// should run a piece of work, without launching anything. A draft is the input to
// the pure compilers (compile.ts) that turn it into chit's existing execution shapes
// (a plan, or a batch task list). It holds the brand line "Dynamic authoring, static
// execution" (docs/specs/roles.md): a draft is authored freely, validated here, and a
// human approves it before any run. This module is browser-safe (no node imports).
//
// What a draft may NOT do: synthesize a manifestPath, permissions, model, adapter, or
// agent config. It selects a vetted execution profile by id (the closed menu in
// config.profiles); the compiler resolves that id and injects the profile's vetted
// defaults. This is the whole point of the contract layer.

import type { RequiredCheck } from "../manifest/types.ts";

// plan  -> a sequential plan: each step's worktree is cut from a base that includes
//          its code dependencies' applied diffs. Code dependencies are real here.
// batch -> a parallel task list: dependencies are launch GATES only; a dependent task
//          does NOT see its dependency's diff. Code dependencies are rejected.
export type DraftStrategy = "plan" | "batch";

// One step of a draft. The dependency intent is split deliberately so the semantics
// are explicit and never overloaded onto one ambiguous `dependencies` field:
//   codeDependsOn  - "this step needs the named steps' CODE." Legal only in a plan
//                    (a plan flows applied diffs forward). Rejected for a batch.
//   orderDependsOn - "launch this step only after the named steps settle, but it does
//                    NOT need their code." Safe everywhere. In a batch it becomes the
//                    launch-gate `dependencies`; in a plan it is handled conservatively
//                    (a plan always flows the prior diff forward, so an order edge there
//                    still implies the dependency's code is present -- see compile.ts).
// A profileId of undefined means the built-in default profile (today's behavior).
export interface DraftStep {
	id: string;
	title: string;
	body: string;
	profileId?: string;
	requiredChecks?: RequiredCheck[];
	maxIterations?: number;
	callTimeoutMs?: number;
	codeDependsOn?: string[];
	orderDependsOn?: string[];
	// Batch-only: the repo-relative paths this step expects to touch. Required for a
	// batch step unless allowPathOverlap is set (the batch compiler enforces this).
	// Not meaningful for a plan step (a plan serializes by code dependency, not by
	// path claim) and rejected there.
	claimedPaths?: string[];
	allowPathOverlap?: boolean;
}

// A parsed, structurally-valid draft. The dependency graph (references + acyclicity)
// is validated at parse; strategy-specific semantics (code deps in a batch, claims in
// a batch, plan-only fields) are enforced by the compilers.
export interface PlannerDraft {
	schema: 1;
	strategy: DraftStrategy;
	title: string;
	steps: DraftStep[];
}
