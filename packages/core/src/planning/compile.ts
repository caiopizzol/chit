// Pure compilers that turn a validated planner draft (parse.ts) into chit's EXISTING
// execution shapes, resolving the selected execution profile through the closed menu
// (config.profiles) and injecting the profile's vetted defaults. The compilers add no
// new execution behavior: a plan draft compiles to the same NormalizedPlan parsePlan
// produces, and a batch draft compiles to the same task-input shape chit_batch_start
// already accepts (apps/cli/src/batches/plan.ts `TaskInput`). They never mutate the
// profile registry or the input draft. No node imports.

import { DEFAULT_PROFILE_ID, type NormalizedProfile } from "../config/types.ts";
import type { RequiredCheck } from "../manifest/types.ts";
import type { NormalizedPlan, PlanStep } from "../plan/types.ts";
import { ClaimError, normalizeClaimedPath } from "./claims.ts";
import { DraftError } from "./parse.ts";
import type { DraftStep, PlannerDraft } from "./types.ts";

// The compiled batch task: STRUCTURALLY identical to apps/cli/src/batches/plan.ts
// `TaskInput`, so a compiled list is fed straight to planTasks at the batch boundary.
// Defined here (not imported) because core is the lower layer and must not depend on
// the CLI; kept in sync by the shared field set. claimedPaths are already validated and
// canonicalized here (via the shared normalizeClaimedPath), so the draft contract
// rejects traversal/absolute claims before a human approves -- planTasks re-normalizing
// them at launch is idempotent. There is deliberately NO maxIterations slot: a batch
// task's iteration budget comes from its manifest policy, so a profile carrying
// maxIterations is rejected at compile rather than silently dropped.
export interface CompiledBatchTask {
	id: string;
	title: string;
	body: string;
	dependencies?: string[];
	claimedPaths?: string[];
	allowPathOverlap?: boolean;
	manifestPath?: string;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
}

// Validate + canonicalize one batch claim via the shared normalizer, re-surfacing a
// ClaimError as a DraftError anchored at the offending step so the contract speaks in
// draft terms.
function normalizeClaim(claim: string, stepId: string): string {
	try {
		return normalizeClaimedPath(claim);
	} catch (e) {
		if (e instanceof ClaimError) throw new DraftError(`steps.${stepId}.claimedPaths`, e.message);
		throw e;
	}
}

// Resolve a step's profileId through the closed menu. Undefined selects the built-in
// default. An id absent from the menu is rejected -- a draft can only pick a vetted
// profile, never invent one.
function resolveProfile(
	step: DraftStep,
	profiles: Record<string, NormalizedProfile>,
): NormalizedProfile {
	const id = step.profileId ?? DEFAULT_PROFILE_ID;
	const profile = profiles[id];
	if (!profile)
		throw new DraftError(`steps.${step.id}.profileId`, `unknown execution profile "${id}"`);
	return profile;
}

// Compile a plan draft to a NormalizedPlan. Code dependencies become plan dependsOn
// (a plan flows applied diffs forward, so they are real). Order-only dependencies are
// handled CONSERVATIVELY: a plan always cuts a step's base from its dependencies'
// applied diffs, so even a pure "launch after" edge ends up exposing the dependency's
// code. Rather than silently strengthen it, we fold orderDependsOn into the SAME
// dependsOn edge set -- the stronger (code-visible) semantics a plan can actually
// offer -- and document it here so the behavior is explicit, not surprising.
export function compilePlanDraft(
	draft: PlannerDraft,
	profiles: Record<string, NormalizedProfile>,
): NormalizedPlan {
	if (draft.strategy !== "plan")
		throw new DraftError(
			"strategy",
			`compilePlanDraft requires strategy "plan", got "${draft.strategy}"`,
		);

	const steps: PlanStep[] = draft.steps.map((s) => {
		// Batch-only fields have no meaning in a plan; reject rather than drop silently.
		if (s.claimedPaths !== undefined)
			throw new DraftError(
				`steps.${s.id}.claimedPaths`,
				"not allowed in a plan draft (batch-only)",
			);
		if (s.allowPathOverlap !== undefined)
			throw new DraftError(
				`steps.${s.id}.allowPathOverlap`,
				"not allowed in a plan draft (batch-only)",
			);

		const profile = resolveProfile(s, profiles);
		const dependsOn = [...new Set([...(s.codeDependsOn ?? []), ...(s.orderDependsOn ?? [])])];

		const step: PlanStep = {
			id: s.id,
			title: s.title,
			body: s.body,
			dependsOn,
		};
		if (s.requiredChecks !== undefined)
			step.requiredChecks = s.requiredChecks.map((c) => ({ ...c }));
		// manifestPath comes ONLY from the vetted profile, never from the draft.
		if (profile.manifestPath !== undefined) step.manifestPath = profile.manifestPath;
		// Closest-wins: an explicit draft override beats the profile default.
		const maxIterations = s.maxIterations ?? profile.maxIterations;
		if (maxIterations !== undefined) step.maxIterations = maxIterations;
		const callTimeoutMs = s.callTimeoutMs ?? profile.callTimeoutMs;
		if (callTimeoutMs !== undefined) step.callTimeoutMs = callTimeoutMs;
		return step;
	});

	return { schema: 1, title: draft.title, steps, cleanup: "after_apply" };
}

// Compile a batch draft to the existing batch task-input shape. Batch dependencies are
// LAUNCH GATES only: a dependent task is cut from the batch base and never receives a
// dependency's diff (apps/cli/src/batches/types.ts). So code dependencies are
// rejected -- they cannot be honored and would be a silently-wrong base. Order-only
// dependencies become the launch-gate `dependencies`. maxIterations is rejected too:
// a batch task takes its iteration budget from the manifest policy, not per task, so
// there is no field to carry it without dropping it silently.
export function compileBatchDraft(
	draft: PlannerDraft,
	profiles: Record<string, NormalizedProfile>,
): CompiledBatchTask[] {
	if (draft.strategy !== "batch")
		throw new DraftError(
			"strategy",
			`compileBatchDraft requires strategy "batch", got "${draft.strategy}"`,
		);

	return draft.steps.map((s) => {
		if ((s.codeDependsOn ?? []).length > 0)
			throw new DraftError(
				`steps.${s.id}.codeDependsOn`,
				"code dependencies are not allowed in a batch draft: batch dependencies are launch gates only " +
					"and a dependent task does not receive its dependencies' diffs. Use a plan draft for code dependencies, " +
					"or move the edge to orderDependsOn if it is launch-order only.",
			);
		if (s.maxIterations !== undefined)
			throw new DraftError(
				`steps.${s.id}.maxIterations`,
				"not allowed in a batch draft: a batch task's iteration budget comes from its manifest policy, " +
					"set it via the execution profile's manifest instead.",
			);

		const claims = s.claimedPaths ?? [];
		if (claims.length === 0 && !s.allowPathOverlap)
			throw new DraftError(
				`steps.${s.id}.claimedPaths`,
				"required for a batch step (declare the paths it will touch), or set allowPathOverlap to run it " +
					"without a declared footprint (it will run alone)",
			);

		const profile = resolveProfile(s, profiles);
		// A profile that vets maxIterations cannot be honored by a batch task (no slot),
		// so reject rather than approve a draft whose effective iteration budget silently
		// differs from the vetted profile. Such a profile is for plan/converge use.
		if (profile.maxIterations !== undefined)
			throw new DraftError(
				`steps.${s.id}.profileId`,
				`execution profile "${profile.id}" sets maxIterations, which a batch task cannot carry: a batch ` +
					"task's iteration budget comes from its manifest policy, not per task. Use this profile in a " +
					"plan draft, or select a profile without maxIterations for a batch.",
			);

		const task: CompiledBatchTask = { id: s.id, title: s.title, body: s.body };
		const dependencies = s.orderDependsOn ?? [];
		if (dependencies.length > 0) task.dependencies = [...dependencies];
		// Validate + canonicalize each claim through the shared normalizer so a traversal
		// or absolute path is rejected at the contract layer, not deferred to launch.
		if (claims.length > 0) task.claimedPaths = claims.map((c) => normalizeClaim(c, s.id));
		if (s.allowPathOverlap) task.allowPathOverlap = true;
		if (profile.manifestPath !== undefined) task.manifestPath = profile.manifestPath;
		if (s.requiredChecks !== undefined)
			task.requiredChecks = s.requiredChecks.map((c) => ({ ...c }));
		const callTimeoutMs = s.callTimeoutMs ?? profile.callTimeoutMs;
		if (callTimeoutMs !== undefined) task.callTimeoutMs = callTimeoutMs;
		return task;
	});
}
