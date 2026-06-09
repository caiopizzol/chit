// MCP handler glue for the draft tools, kept out of the giant server module so the
// security boundary, the approval-hash gate between a previewed draft and a real
// launch, is unit-testable without the MCP wiring or a live repo. The gate logic
// (parse, compile, hash, confirm, hash-match) is pure; the launch itself dispatches to
// the EXISTING plan/batch engine path through injected stores + deps, exactly as
// chit_plan_start / chit_batch_start do. There is no second executor here.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	bindDraftApprovalBase,
	type CompiledArtifact,
	canonicalApprovalPayload,
	compileDraftArtifact,
	type DraftApprovalArtifact,
	type DraftApprovalBase,
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
import { repoToplevel, resolveBaseSha } from "../../batches/worktree.ts";
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

// The approval hash for a compiled draft artifact plus resolved base: a sha256 over the
// core's canonical payload bytes. The canonical serialization (core) sorts keys at every
// depth, so the hash binds the artifact's VALUE, not the order it was built in. Node
// crypto lives here in the CLI layer, never in @chit-run/core (which stays browser-safe
// and only builds the payload).
export function draftApprovalHash(artifact: DraftApprovalArtifact): string {
	return createHash("sha256").update(canonicalApprovalPayload(artifact)).digest("hex");
}

// A confirmed launch was refused at the approval gate (missing or non-matching hash). It
// is the caller's own error and carries no local paths, so the handler surfaces it
// verbatim, distinct from a DraftError (a bad draft) and from an engine launch error.
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

export interface DraftLaunchBase extends DraftApprovalBase {}

// The stores + engine deps a launch needs, injected so the gate is testable with fakes.
// The store resolvers are LAZY (only called on a confirmed, hash-matched launch), so a
// dry run creates no plan, batch, worktree, job, or state. It does read git to resolve
// the base commit because that commit is part of what the operator approves.
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
	| {
			launched: false;
			strategy: DraftStrategy;
			preview: DraftPreview;
			base: DraftLaunchBase;
			approvalHash: string;
	  }
	| {
			launched: true;
			strategy: "plan";
			view: PlanView;
			base: DraftLaunchBase;
			approvalHash: string;
	  }
	| {
			launched: true;
			strategy: "batch";
			view: BatchView;
			base: DraftLaunchBase;
			approvalHash: string;
	  };

function baseRefFor(artifact: CompiledArtifact, input: DraftLaunchInput): string {
	if (input.baseBranch !== undefined) return input.baseBranch;
	if (artifact.strategy === "plan" && artifact.plan.baseBranch !== undefined) {
		return artifact.plan.baseBranch;
	}
	return "HEAD";
}

function resolveDraftLaunchBase(
	artifact: CompiledArtifact,
	input: DraftLaunchInput,
	deps: DraftLaunchDeps,
): DraftLaunchBase {
	const ref = baseRefFor(artifact, input);
	const runCwd = resolve(input.cwd ?? process.cwd());
	const git = artifact.strategy === "plan" ? deps.planDeps.git : deps.batchDeps.git;
	const callerCheckout = repoToplevel(git, runCwd);
	return { ref, sha: resolveBaseSha(git, callerCheckout, ref) };
}

// The chit_draft_launch core. Parse + compile + hash always (so a bad draft fails the
// same as a preview); then the gate:
//   - confirm omitted/false -> DRY RUN: return the preview + the approval hash, launch
//     nothing, create no state.
//   - confirm true -> require the operator's approvalHash AND that it matches the hash
//     just recomputed from THIS call's draft and resolved base. A missing or stale hash
//     throws DraftLaunchRefused before any engine call, so a draft or base changed after
//     approval can never reach execution on an old hash.
// A matched launch goes through launchNormalizedPlan (plan) / startBatch (batch), the
// same engine path the operator-authored tools use. The compiled artifact is launched
// VERBATIM and from the approved base SHA, so what runs is what was approved.
export function runDraftLaunch(input: DraftLaunchInput, deps: DraftLaunchDeps): DraftLaunchResult {
	const parsed = parseDraft(coerceDraftInput(input.draft));
	const artifact = compileDraftArtifact(parsed, deps.profiles);
	const base = resolveDraftLaunchBase(artifact, input, deps);
	const approvalArtifact = bindDraftApprovalBase(artifact, base);
	const hash = draftApprovalHash(approvalArtifact);

	if (input.confirm !== true) {
		return {
			launched: false,
			strategy: artifact.strategy,
			preview: previewDraft(parsed, deps.profiles),
			base,
			approvalHash: hash,
		};
	}

	if (input.approvalHash === undefined || input.approvalHash.length === 0) {
		throw new DraftLaunchRefused(
			"confirmed launch requires approval_hash: run chit_draft_launch once without confirm " +
				"to review the preview and resolved base, then pass it back with confirm:true",
		);
	}
	if (input.approvalHash !== hash) {
		throw new DraftLaunchRefused(
			"approval_hash does not match the compiled draft: it changed since it was approved " +
				`(recomputed ${hash}). Re-run chit_draft_launch without confirm, review the new preview and base, and pass the new approval_hash.`,
		);
	}

	if (artifact.strategy === "plan") {
		const { store, cwd } = deps.planStoreFor(input.cwd);
		const view = launchNormalizedPlan(
			{
				normalizedPlan: artifact.plan,
				baseBranch: base.sha,
			},
			cwd,
			store,
			deps.planDeps,
			deps.genId,
		);
		return { launched: true, strategy: "plan", view, base, approvalHash: hash };
	}

	const { store, cwd } = deps.batchStoreFor(input.cwd);
	const batch = startBatch(store, deps.batchDeps, {
		id: deps.genId(),
		cwd,
		tasks: artifact.batch,
		maxParallel: input.maxParallel ?? DEFAULT_MAX_PARALLEL,
		baseBranch: base.sha,
	});
	return {
		launched: true,
		strategy: "batch",
		view: describeBatch(batch, deps.batchDeps),
		base,
		approvalHash: hash,
	};
}
