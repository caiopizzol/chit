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

// One step in a plan. body is the brief handed to the converge implementer.
// dependsOn names other step ids and means a CODE dependency: the named steps must be
// applied and committed to the integration branch before this step launches. It is
// normalized to [] when absent. commitMessage is the subject line the gated apply
// commits this step under on the integration branch (single line, reviewed with the
// plan -- the approval hash binds it); absent falls back to `plan step <id>: <title>`.
// The remaining fields are converge-run overrides, preserved only when the author
// provides them.
export interface PlanStep {
	id: string;
	title: string;
	body: string;
	dependsOn: string[];
	commitMessage?: string;
	requiredChecks?: RequiredCheck[];
	manifestPath?: string;
	maxIterations?: number;
	callTimeoutMs?: number;
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
