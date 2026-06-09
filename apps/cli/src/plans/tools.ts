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
	type NormalizedPlan,
	type PlanApprovalArtifact,
	type PlanApprovalBase,
	PlanError,
	parsePlan,
} from "@chit-run/core";
import { repoToplevel, resolveBaseSha } from "../batches/worktree.ts";
import {
	applyPlanStep,
	cleanupPlan,
	describePlan,
	type PlanApplyOutcome,
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
	const artifact = buildPlanApprovalArtifact(normalizedPlan, base, input.maxIterations);
	const hash = planApprovalHash(artifact);

	if (input.confirm !== true) {
		return {
			launched: false,
			strategy: "plan",
			plan: normalizedPlan,
			base,
			...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
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
		},
		cwd,
		store,
		deps,
		genId,
	);
	return { launched: true, view, base, approvalHash: hash };
}

// Launch an ALREADY-parsed, approved plan through the exact startPlan engine path. runPlanStart
// parses + gates + hashes before this point, so there is no plan JSON to parse here: the
// approved plan is started directly. Keeping this beside runPlanStart keeps the gate and the
// launch in one place and one view.
export function launchNormalizedPlan(
	input: { normalizedPlan: NormalizedPlan; baseBranch?: string; maxIterations?: number },
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
	input: { planId: string; confirm?: boolean },
	store: PlanStore,
	deps: PlanEngineDeps,
): PlanCleanupResponse {
	const result = cleanupPlan(store, deps, input.planId, input.confirm ?? false);
	// Re-read so the view reflects cleanedAt (cleanupPlan persisted it on a confirmed run).
	const plan = store.get(input.planId);
	return { ...result, plan: describePlan(plan ?? throwMissing(input.planId), deps) };
}

function throwMissing(planId: string): never {
	throw new PlanError("plan_id", `plan ${JSON.stringify(planId)} vanished during cleanup`);
}
