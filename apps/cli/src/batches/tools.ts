// MCP handler glue for the batch tools, kept out of the giant server module so the
// batch engine's public input contract is unit-testable without the MCP wiring. This
// slice covers chit_batch_start input normalization and the universal approval gate; the
// engine (start/advance/describe/cancel/cleanup) and the real side-effecting deps are
// wired in server.ts. Mirrors plans/tools.ts so the two strategies gate identically.

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
	type BatchApprovalArtifact,
	type BatchApprovalBase,
	buildBatchApprovalArtifact,
	canonicalBatchApprovalPayload,
	type RequiredCheck,
} from "@chit-run/core";
import { type BatchEngineDeps, type BatchView, describeBatch, startBatch } from "./engine.ts";
import { planTasks, type TaskInput } from "./plan.ts";
import type { BatchStore } from "./store.ts";
import { type BatchTask, MAX_PARALLEL_CAP } from "./types.ts";
import { repoToplevel, resolveBaseSha } from "./worktree.ts";

// The effective batch knobs the gate binds and startBatch executes with when the caller
// omits them. maxParallel mirrors the chit_batch_start schema default; maxIterations
// mirrors both the schema default and the engine's DEFAULT_MAX_ITERATIONS. The gate always
// passes the resolved value through to startBatch, so the engine's own `?? default` is a
// no-op and the artifact's bound knob can never diverge from what actually runs.
const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_MAX_ITERATIONS = 3;

// Resolve a (possibly relative) manifest path to an absolute path against the batch cwd, so
// the dry run hashes and the confirmed start launches the SAME concrete path -- a relative
// path re-resolved against a task worktree later would point somewhere else.
function resolveManifestAbsolute(manifestPath: string, cwd: string): string {
	return isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath);
}

export interface BatchStartInput {
	tasks: TaskInput[];
	maxParallel?: number;
	baseBranch?: string;
	manifestPath?: string;
	maxIterations?: number;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
	// The universal approval gate. confirm omitted/false is a DRY RUN (review only); confirm
	// true launches, and then requires an approvalHash that matches the dry run's.
	confirm?: boolean;
	approvalHash?: string;
}

// A confirmed batch start was refused at the approval gate (missing or non-matching hash).
// It is the caller's own error and carries no local paths, so the handler surfaces it
// verbatim, distinct from a PlanError (a bad graph) and from an engine launch error.
export class BatchApprovalRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BatchApprovalRefused";
	}
}

// The approval hash for a normalized task graph plus resolved base plus launch-time knobs: a
// sha256 over the core's canonical payload bytes. The canonical serialization (core) sorts
// keys at every depth, so the hash binds the artifact's VALUE, not the order it was built in.
// Node crypto lives here in the CLI layer, never in @chit-run/core (which stays browser-safe
// and only builds the payload).
export function batchApprovalHash(artifact: BatchApprovalArtifact): string {
	return createHash("sha256").update(canonicalBatchApprovalPayload(artifact)).digest("hex");
}

export type BatchStartResult =
	| {
			launched: false;
			strategy: "batch";
			tasks: BatchTask[];
			base: BatchApprovalBase;
			maxParallel: number;
			maxIterations: number;
			manifestPath?: string;
			requiredChecks?: RequiredCheck[];
			callTimeoutMs?: number;
			approvalHash: string;
	  }
	| { launched: true; view: BatchView; base: BatchApprovalBase; approvalHash: string };

// The chit_batch_start handler core, with the store, engine deps, and id generator injected
// so it is testable without resolving a real repo or spawning the detached converge workers
// the real deps launch. It is universally gated:
//   - confirm omitted/false -> DRY RUN: normalize the task graph, resolve the base ref to a
//     concrete commit, resolve manifest paths, apply the launch-time knob defaults/caps, build
//     the approval artifact, and return launched:false with the normalized tasks, base, knobs,
//     and hash. It creates NO batch record, worktree, job, or branch -- it only reads git to
//     resolve the base commit, which is part of what the operator approves.
//   - confirm true -> require approvalHash AND that it matches the hash recomputed from THIS
//     call's re-normalized graph, re-resolved base, and re-applied knobs. A missing or stale
//     hash throws BatchApprovalRefused BEFORE any mutation, so a graph, base, or knob changed
//     after approval can never reach execution on an old hash. On a match, launch through the
//     SAME startBatch engine path, pinned to the approved base SHA (not the moving ref) so
//     every task worktree branches from exactly the commit that was approved.
export function runBatchStart(
	input: BatchStartInput,
	cwd: string,
	store: BatchStore,
	deps: BatchEngineDeps,
	genId: () => string,
): BatchStartResult {
	// Resolve manifest paths to absolute up front so the dry-run artifact and the confirmed
	// launch bind/run the SAME paths. The per-task override is resolved here too; planTasks
	// then carries the absolute path onto the BatchTask the artifact is built from.
	const batchManifest =
		input.manifestPath !== undefined ? resolveManifestAbsolute(input.manifestPath, cwd) : undefined;
	const plannedInputs: TaskInput[] = input.tasks.map((t) => ({
		...t,
		...(t.manifestPath !== undefined && {
			manifestPath: resolveManifestAbsolute(t.manifestPath, cwd),
		}),
	}));

	// Normalize + validate the graph BEFORE any side effect (throws PlanError on a bad graph),
	// exactly as startBatch will: a malformed batch is rejected at the gate, not after a base
	// resolve or a launch. The normalized tasks are what the artifact (and the operator) review.
	const normalizedTasks = planTasks(plannedInputs);

	// Resolve the base ref to a concrete commit exactly as startBatch does: the ref the operator
	// names, resolved against the LAUNCHING checkout so a linked-worktree launch pins to that
	// checkout's tip, not the main repo's HEAD. Binding the sha (not just the ref) means a ref
	// that moves between approval and confirmation changes the hash.
	const ref = input.baseBranch ?? "HEAD";
	const callerCheckout = repoToplevel(deps.git, cwd);
	const sha = resolveBaseSha(deps.git, callerCheckout, ref);
	const base: BatchApprovalBase = { ref, sha };

	// Apply the SAME defaults/caps startBatch will execute with, and bind those effective values
	// (not the raw inputs) so the operator approves what actually runs.
	const maxParallel = Math.max(
		1,
		Math.min(input.maxParallel ?? DEFAULT_MAX_PARALLEL, MAX_PARALLEL_CAP),
	);
	const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	const artifact = buildBatchApprovalArtifact({
		base,
		// BatchTask is structurally assignable to BatchApprovalTaskInput; its runtime-only fields
		// (status, worktreePath, ...) are ignored by the builder.
		tasks: normalizedTasks,
		maxParallel,
		maxIterations,
		...(batchManifest !== undefined && { manifestPath: batchManifest }),
		...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
		...(input.callTimeoutMs !== undefined && { callTimeoutMs: input.callTimeoutMs }),
	});
	const hash = batchApprovalHash(artifact);

	if (input.confirm !== true) {
		return {
			launched: false,
			strategy: "batch",
			tasks: normalizedTasks,
			base,
			maxParallel,
			maxIterations,
			...(batchManifest !== undefined && { manifestPath: batchManifest }),
			...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
			...(input.callTimeoutMs !== undefined && { callTimeoutMs: input.callTimeoutMs }),
			approvalHash: hash,
		};
	}

	if (input.approvalHash === undefined || input.approvalHash.length === 0) {
		throw new BatchApprovalRefused(
			"a confirmed batch start requires approval_hash: run chit_batch_start once without confirm " +
				"to review the task graph and resolved base, then pass the shown approval_hash back with confirm:true",
		);
	}
	if (input.approvalHash !== hash) {
		throw new BatchApprovalRefused(
			"approval_hash does not match the task graph, resolved base, and knobs: they changed since approval " +
				`(recomputed ${hash}). Re-run chit_batch_start without confirm, review the new graph and base, and pass the new approval_hash.`,
		);
	}

	const batch = startBatch(store, deps, {
		id: genId(),
		cwd,
		tasks: plannedInputs,
		maxParallel,
		// Pin to the approved COMMIT, not the ref: even if the ref moved after approval, the hash
		// already matched the sha, so every task worktree branches from exactly what was approved.
		baseBranch: base.sha,
		maxIterations,
		...(batchManifest !== undefined && { manifestPath: batchManifest }),
		...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
		...(input.callTimeoutMs !== undefined && { callTimeoutMs: input.callTimeoutMs }),
	});
	return { launched: true, view: describeBatch(batch, deps), base, approvalHash: hash };
}
