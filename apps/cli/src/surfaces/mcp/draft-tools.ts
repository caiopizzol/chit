// MCP handler glue for the draft tools, kept out of the giant server module so the
// security boundary -- the approval-hash gate between a previewed draft and a real
// launch -- is unit-testable without the MCP wiring or a live repo. The gate logic
// (parse, compile, hash, confirm, hash-match) is pure; the launch itself dispatches to
// the EXISTING plan/batch engine path through injected stores + deps, exactly as
// chit_plan_start / chit_batch_start do. There is no second executor here.

import { createHash } from "node:crypto";
import {
	type CompiledArtifact,
	canonicalApprovalPayload,
	compileDraftArtifact,
	DraftError,
	type DraftPreview,
	type DraftStrategy,
	type NormalizedProfile,
	parseDraft,
	previewDraft,
} from "@chit-run/core";
import {
	type BatchEngineDeps,
	type BatchView,
	describeBatch,
	startBatch,
} from "../../batches/engine.ts";
import type { BatchStore } from "../../batches/store.ts";
import type { PlanEngineDeps, PlanView } from "../../plans/engine.ts";
import type { PlanStore } from "../../plans/store.ts";
import { launchNormalizedPlan } from "../../plans/tools.ts";

// Map a draft-string input to an object: parse a JSON string, pass an object through.
// A non-JSON string is the operator's most likely mistake, so it gets its own message
// rather than the generic structural error parseDraft would raise on a bare string.
export function coerceDraftInput(draft: string | Record<string, unknown>): unknown {
	if (typeof draft !== "string") return draft;
	try {
		return JSON.parse(draft);
	} catch (e) {
		throw new DraftError("$", `draft is not valid JSON: ${(e as Error).message}`);
	}
}

// The approval hash for a compiled draft artifact: a sha256 over the core's canonical
// payload bytes. The canonical serialization (core) sorts keys at every depth, so the
// hash binds the artifact's VALUE, not the order it was built in. Node crypto lives here
// in the CLI layer, never in @chit-run/core (which stays browser-safe and only builds the
// payload).
export function draftApprovalHash(artifact: CompiledArtifact): string {
	return createHash("sha256").update(canonicalApprovalPayload(artifact)).digest("hex");
}

// A confirmed launch was refused at the approval gate (missing or non-matching hash). It
// is the caller's own error and carries no local paths, so the handler surfaces it
// verbatim -- distinct from a DraftError (a bad draft) and from an engine launch error.
export class DraftLaunchRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DraftLaunchRefused";
	}
}

export interface DraftLaunchInput {
	draft: string | Record<string, unknown>;
	approvalHash?: string;
	confirm?: boolean;
	cwd?: string;
	baseBranch?: string;
	maxParallel?: number;
}

// The stores + engine deps a launch needs, injected so the gate is testable with fakes.
// The store resolvers are LAZY (only called on a confirmed, hash-matched launch), so a
// dry run never resolves a repo or touches git -- it stays as read-only as a preview.
export interface DraftLaunchDeps {
	profiles: Record<string, NormalizedProfile>;
	planStoreFor: (cwd?: string) => { store: PlanStore; cwd: string };
	planDeps: PlanEngineDeps;
	batchStoreFor: (cwd?: string) => { store: BatchStore; cwd: string };
	batchDeps: BatchEngineDeps;
	genId: () => string;
}

// Default per-task/per-step concurrency + budget, matching chit_batch_start.
const DEFAULT_MAX_PARALLEL = 2;

export type DraftLaunchResult =
	| { launched: false; strategy: DraftStrategy; preview: DraftPreview; approvalHash: string }
	| { launched: true; strategy: "plan"; view: PlanView; approvalHash: string }
	| { launched: true; strategy: "batch"; view: BatchView; approvalHash: string };

// The chit_draft_launch core. Parse + compile + hash always (so a bad draft fails the
// same as a preview); then the gate:
//   - confirm omitted/false -> DRY RUN: return the preview + the approval hash, launch
//     nothing, create no state.
//   - confirm true -> require the operator's approvalHash AND that it matches the hash
//     just recomputed from THIS call's draft. A missing or stale hash throws
//     DraftLaunchRefused before any engine call, so a draft edited after approval can
//     never reach execution on an old hash.
// A matched launch goes through launchNormalizedPlan (plan) / startBatch (batch) -- the
// same engine path the operator-authored tools use. The compiled artifact is launched
// VERBATIM (its profile-injected manifestPath and budgets are exactly what the hash
// bound), so what runs is what was approved.
export function runDraftLaunch(input: DraftLaunchInput, deps: DraftLaunchDeps): DraftLaunchResult {
	const parsed = parseDraft(coerceDraftInput(input.draft));
	const artifact = compileDraftArtifact(parsed, deps.profiles);
	const hash = draftApprovalHash(artifact);

	if (input.confirm !== true) {
		return {
			launched: false,
			strategy: artifact.strategy,
			preview: previewDraft(parsed, deps.profiles),
			approvalHash: hash,
		};
	}

	if (input.approvalHash === undefined || input.approvalHash.length === 0) {
		throw new DraftLaunchRefused(
			"confirmed launch requires approval_hash: run chit_draft_launch once without confirm " +
				"(or chit_draft_preview) to review the preview and obtain the hash, then pass it back with confirm:true",
		);
	}
	if (input.approvalHash !== hash) {
		throw new DraftLaunchRefused(
			"approval_hash does not match the compiled draft: it changed since it was approved " +
				`(recomputed ${hash}). Re-run chit_draft_launch without confirm, review the new preview, and pass the new approval_hash.`,
		);
	}

	if (artifact.strategy === "plan") {
		const { store, cwd } = deps.planStoreFor(input.cwd);
		const view = launchNormalizedPlan(
			{
				normalizedPlan: artifact.plan,
				...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
			},
			cwd,
			store,
			deps.planDeps,
			deps.genId,
		);
		return { launched: true, strategy: "plan", view, approvalHash: hash };
	}

	const { store, cwd } = deps.batchStoreFor(input.cwd);
	const batch = startBatch(store, deps.batchDeps, {
		id: deps.genId(),
		cwd,
		tasks: artifact.batch,
		maxParallel: input.maxParallel ?? DEFAULT_MAX_PARALLEL,
		...(input.baseBranch !== undefined && { baseBranch: input.baseBranch }),
	});
	return {
		launched: true,
		strategy: "batch",
		view: describeBatch(batch, deps.batchDeps),
		approvalHash: hash,
	};
}
