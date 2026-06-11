// The sequential plan-runner file shape (see docs/sequential-plan-runner-design.md).
// A plan is an operator-authored, reviewed JSON file: an ordered list of steps with
// declared code dependencies. This module describes the NORMALIZED shape parsePlan
// produces; node-side resolution (manifest paths, integration branch) layers on top.

import type { RequiredCheck } from "../manifest/types.ts";

// v1 fixes apply to "gated": every diff flows through an operator-confirmed apply.
// The field exists so a future "auto-on-clean" is additive, not a schema break.
export type PlanApplyPolicy = "gated";

// after_apply (default) retires a step's worktree once its diff is committed to the
// integration branch; manual keeps every worktree until an explicit cleanup.
export type PlanCleanupPolicy = "after_apply" | "manual";

// v1 handoff format. JSON only: a bounded, machine-readable, parseable channel. The type
// stays a closed union so a future format is an additive change, not a schema break.
export type PlanHandoffFormat = "json";

// A structured artifact a step declares it will produce (see
// docs/structured-plan-handoffs-design.md). path is RELATIVE to the producing step's
// worktree root and is validated to stay inside it (no absolute/drive forms, no
// empty/dot/dotdot segments, never under .git). format is the parseable shape; maxBytes is
// the per-handoff size cap chit enforces when it later captures the file (normalized to a
// conservative default when the author omits it). The declaration binds into the approval
// hash; the produced CONTENT is gated separately at apply time (Phase 3), not here.
export interface PlanHandoff {
	path: string;
	format: PlanHandoffFormat;
	maxBytes: number;
}

// A consume edge: a later step pulls an accepted handoff from an earlier step into its own
// prompt under a local alias. step names the producing step, handoff its declared handoff
// id, and as the alias the consuming step refers to it by. The producing step must be in
// this step's dependsOn closure (no hidden data dependency bypasses the code-dependency
// graph), and aliases are unique per consuming step. Runtime injection is Phase 4; this is
// the declared, approval-bound edge only.
export interface PlanConsume {
	step: string;
	handoff: string;
	as: string;
}

// One step in a plan. body is the brief handed to the converge implementer.
// dependsOn names other step ids and means a CODE dependency: the named steps must be
// applied and committed to the integration branch before this step launches. It is
// normalized to [] when absent. commitMessage is the subject line the gated apply
// commits this step under on the integration branch (single line, reviewed with the
// plan -- the approval hash binds it); absent falls back to `plan step <id>: <title>`.
// recipe names a vetted config recipe by id: the recipe supplies the manifest and the
// default runtime budgets, so a planner selects from a closed menu instead of writing
// paths. recipe and manifestPath are mutually exclusive (manifestPath stays available
// for manual expert use). The remaining fields are converge-run overrides, preserved
// only when the author provides them; when a recipe is named, a step-level
// maxIterations/callTimeoutMs overrides that recipe's default.
export interface PlanStep {
	id: string;
	title: string;
	body: string;
	dependsOn: string[];
	commitMessage?: string;
	requiredChecks?: RequiredCheck[];
	recipe?: string;
	manifestPath?: string;
	maxIterations?: number;
	callTimeoutMs?: number;
	// handoffs this step produces, keyed by handoff id. Preserved only when the author
	// declares at least one (an empty map normalizes to absent, so it never perturbs the hash).
	handoffs?: Record<string, PlanHandoff>;
	// accepted handoffs this step consumes, in declared order. Preserved only when non-empty.
	consumes?: PlanConsume[];
	// the per-step total byte budget across ALL consumed handoffs, so several accepted
	// handoffs cannot silently stack into an oversized prompt. Present (normalized to a
	// conservative default when the author omits it) only on a step that consumes.
	maxConsumedBytes?: number;
}

// A parsed, structurally-valid plan. id and baseBranch are preserved only when the
// author supplies them (a uuid / the resolved base are filled in node-side). cleanup
// is normalized to its default; apply is preserved only when present.
export interface NormalizedPlan {
	schema: 1;
	id?: string;
	title: string;
	baseBranch?: string;
	steps: PlanStep[];
	apply?: PlanApplyPolicy;
	cleanup: PlanCleanupPolicy;
}
