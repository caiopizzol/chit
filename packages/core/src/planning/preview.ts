// A read-only preview of a planner-authored draft's COMPILED execution shape. This is
// the approval surface: it runs the same pure compilers (compile.ts) a real launch
// would, so every validation a launch enforces (unknown profile, plan-only manifestPath,
// batch codeDependsOn, missing/traversal claims, cycles) fails HERE, before a human
// approves -- but it launches nothing, calls no model, and touches no git/state. It
// returns a compact, sanitized summary of what would run, never the raw compiled shape
// (no prompts beyond a capped body one-liner, no secrets, no config internals). Browser
// safe (no node imports), so Studio or the MCP tool can both build the same preview.

import { DEFAULT_PROFILE_ID, type NormalizedProfile } from "../config/types.ts";
import { compileBatchDraft, compilePlanDraft } from "./compile.ts";
import type { DraftStep, DraftStrategy, PlannerDraft } from "./types.ts";

// The longest body one-liner a preview surfaces. A draft step body can be a full prompt;
// the preview shows only enough to recognize the step, never the whole thing.
const BODY_PREVIEW_MAX = 140;

// Collapse a step body to a single capped line: a draft body may be multi-line and long,
// and the preview is for recognition, not for reading the prompt. Whitespace runs collapse
// to one space; the result is truncated with "..." when it would exceed the cap.
function bodyPreview(body: string): string {
	const line = body.replace(/\s+/g, " ").trim();
	return line.length > BODY_PREVIEW_MAX ? `${line.slice(0, BODY_PREVIEW_MAX - 3)}...` : line;
}

// The profile a draft step selects, named for the preview. Undefined selects the built-in
// default; the compiler has already proven the id resolves, so this only reports it.
function profileOf(step: DraftStep): { profileId: string; usesDefaultProfile: boolean } {
	return {
		profileId: step.profileId ?? DEFAULT_PROFILE_ID,
		usesDefaultProfile: step.profileId === undefined,
	};
}

// One plan step in the preview: its compiled dependency edges, the resolved profile, and
// the EFFECTIVE knobs the compiler injected (manifestPath presence only -- never the path
// itself -- plus the iteration/timeout/check budget). bodyPreview is the only prompt text.
export interface PlanStepPreview {
	id: string;
	title: string;
	dependsOn: string[];
	profileId: string;
	usesDefaultProfile: boolean;
	hasManifestPath: boolean;
	maxIterations?: number;
	callTimeoutMs?: number;
	requiredCheckCount: number;
	bodyPreview: string;
}

// One batch task in the preview: its launch-gate dependencies (order-only), the normalized
// path claims, the resolved profile, and the effective knobs. Mirrors PlanStepPreview minus
// maxIterations (a batch task carries none) plus the claim fields.
export interface BatchTaskPreview {
	id: string;
	title: string;
	dependencies: string[];
	claimedPaths: string[];
	allowPathOverlap: boolean;
	profileId: string;
	usesDefaultProfile: boolean;
	hasManifestPath: boolean;
	callTimeoutMs?: number;
	requiredCheckCount: number;
	bodyPreview: string;
}

// The compact preview returned to the approver. Exactly one of `plan`/`batch` is present,
// matching `strategy`. `status` is a fixed marker that the draft compiled cleanly; any
// failure throws a DraftError out of the compiler instead of returning a preview.
export interface DraftPreview {
	strategy: DraftStrategy;
	title: string;
	stepCount: number;
	status: "preview_ready";
	plan?: { steps: PlanStepPreview[] };
	batch?: { tasks: BatchTaskPreview[] };
}

// Compile a validated draft through the real compilers and summarize the result. Throws a
// DraftError (from parse/compile) when the draft cannot be honored -- the caller surfaces
// that as a structured error. Never mutates the draft or the profile menu. The compiled
// steps preserve draft order (the compilers map over draft.steps), so each is zipped with
// its source step by index to recover the selected profile id, which the compiled shape
// drops once resolved.
export function previewDraft(
	draft: PlannerDraft,
	profiles: Record<string, NormalizedProfile>,
): DraftPreview {
	if (draft.strategy === "plan") {
		const compiled = compilePlanDraft(draft, profiles);
		const steps: PlanStepPreview[] = compiled.steps.map((step, i) => {
			const source = draft.steps[i] as DraftStep;
			return {
				id: step.id,
				title: step.title,
				dependsOn: step.dependsOn,
				...profileOf(source),
				hasManifestPath: step.manifestPath !== undefined,
				...(step.maxIterations !== undefined && { maxIterations: step.maxIterations }),
				...(step.callTimeoutMs !== undefined && { callTimeoutMs: step.callTimeoutMs }),
				requiredCheckCount: step.requiredChecks?.length ?? 0,
				bodyPreview: bodyPreview(step.body),
			};
		});
		return {
			strategy: "plan",
			title: draft.title,
			stepCount: steps.length,
			status: "preview_ready",
			plan: { steps },
		};
	}

	const compiled = compileBatchDraft(draft, profiles);
	const tasks: BatchTaskPreview[] = compiled.map((task, i) => {
		const source = draft.steps[i] as DraftStep;
		return {
			id: task.id,
			title: task.title,
			dependencies: task.dependencies ?? [],
			claimedPaths: task.claimedPaths ?? [],
			allowPathOverlap: task.allowPathOverlap ?? false,
			...profileOf(source),
			hasManifestPath: task.manifestPath !== undefined,
			...(task.callTimeoutMs !== undefined && { callTimeoutMs: task.callTimeoutMs }),
			requiredCheckCount: task.requiredChecks?.length ?? 0,
			bodyPreview: bodyPreview(task.body),
		};
	});
	return {
		strategy: "batch",
		title: draft.title,
		stepCount: tasks.length,
		status: "preview_ready",
		batch: { tasks },
	};
}
