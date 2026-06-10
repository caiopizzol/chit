// MCP handler glue for the batch tools, kept out of the giant server module so the
// batch engine's public input contract is unit-testable without the MCP wiring. This
// slice covers chit_batch_start input normalization and the universal approval gate; the
// engine (start/advance/describe/cancel/cleanup) and the real side-effecting deps are
// wired in server.ts. Mirrors plans/tools.ts so the two strategies gate identically.

import { createHash } from "node:crypto";
import {
	type BatchApprovalArtifact,
	type BatchApprovalBase,
	type BatchManifestBindings,
	type BatchRecipeBindings,
	buildBatchApprovalArtifact,
	canonicalBatchApprovalPayload,
	type ManifestBinding,
	type RecipeReceipt,
	type RequiredCheck,
} from "@chit-run/core";
import { normalizeManifestReference, type ResolvedRecipe } from "../manifest/binding.ts";
import { type BatchEngineDeps, type BatchView, describeBatch, startBatch } from "./engine.ts";
import { assertRecipeId, PlanError, planTasks, type TaskInput } from "./plan.ts";
import type { BatchStore } from "./store.ts";
import { type BatchTask, MAX_PARALLEL_CAP } from "./types.ts";
import { repoToplevel, resolveBaseSha } from "./worktree.ts";

// The effective batch knobs the gate binds and startBatch executes with when the caller
// omits them. maxParallel mirrors the chit_batch_start schema default; maxIterations
// mirrors the engine's DEFAULT_MAX_ITERATIONS (the schema leaves max_iterations optional
// so a batch recipe's default can apply: explicit input > batch recipe > this). The gate
// always passes the resolved value through to startBatch, so the engine's own `?? default`
// is a no-op and the artifact's bound knob can never diverge from what actually runs.
const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_MAX_ITERATIONS = 3;

// Normalize a manifest reference to its bound identity: an absolute path stays
// itself (a global, operator-named file); a relative path becomes repo-root
// relative (rejecting repo escapes) and is later read from the GIT TREE at the
// batch base -- the content the task worktree checks out -- never from the caller
// checkout's working tree. The worker then resolves the same relative path against
// its task worktree, so the dry run binds exactly the bytes the task reads.
function normalizeManifestIdentity(
	manifestPath: string,
	cwd: string,
	repoRoot: string,
	context: string,
): string {
	try {
		return normalizeManifestReference(manifestPath, cwd, repoRoot).manifestPath;
	} catch (e) {
		throw new PlanError(`${context}: ${(e as Error).message}`);
	}
}

export interface BatchStartInput {
	tasks: TaskInput[];
	maxParallel?: number;
	baseBranch?: string;
	// Batch-level config recipe id: a vetted manifest reference + safe runtime defaults,
	// applied to every task without its own recipe or manifestPath. Mutually exclusive
	// with manifestPath (the recipe supplies the manifest).
	recipe?: string;
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
			recipe?: string;
			manifestPath?: string;
			requiredChecks?: RequiredCheck[];
			callTimeoutMs?: number;
			// The resolved manifest bindings (batch default + per-task overrides): content
			// digest + safe participant execution summary, bound by the approval hash so
			// the operator reviews the execution surface, not just a path string.
			manifests?: BatchManifestBindings;
			// The resolved recipe receipts (batch default + per-task selections): identity,
			// provenance, and runtime defaults, also hash-bound, so the preview shows exactly
			// what every recipe resolved to before approval (next to its manifest binding).
			recipes?: BatchRecipeBindings;
			approvalHash: string;
	  }
	| { launched: true; view: BatchView; base: BatchApprovalBase; approvalHash: string };

// The chit_batch_start handler core, with the store, engine deps, and id generator injected
// so it is testable without resolving a real repo or spawning the detached converge workers
// the real deps launch. It is universally gated:
//   - confirm omitted/false -> DRY RUN: normalize the task graph, resolve the base ref to a
//     concrete commit, resolve manifest paths and recipe selections (each recipe to its
//     receipt + manifest binding), apply the launch-time knob defaults/caps, build
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
	// Batch-level recipe vs manifest_path: same mutual exclusivity as the per-task rule
	// planTasks enforces (the recipe supplies the manifest), checked BEFORE any git read.
	if (input.recipe !== undefined && input.manifestPath !== undefined) {
		throw new PlanError(
			"recipe and manifest_path are mutually exclusive (the recipe supplies the manifest)",
		);
	}
	if (input.recipe !== undefined) assertRecipeId(input.recipe, "recipe");

	// Normalize manifest references up front so the dry-run artifact and the confirmed
	// launch bind/run the SAME identity: absolute paths stay themselves; relative paths
	// become repo-root relative (rejecting repo escapes) and are read from the git tree
	// at the batch base. The per-task override is normalized here too; planTasks then
	// carries the normalized path onto the BatchTask the artifact is built from.
	const callerCheckout = repoToplevel(deps.git, cwd);
	const batchManifest =
		input.manifestPath !== undefined
			? normalizeManifestIdentity(input.manifestPath, cwd, callerCheckout, "manifest_path")
			: undefined;
	const plannedInputs: TaskInput[] = input.tasks.map((t) => ({
		...t,
		...(t.manifestPath !== undefined && {
			manifestPath: normalizeManifestIdentity(
				t.manifestPath,
				cwd,
				callerCheckout,
				`task ${JSON.stringify(t.id)} manifestPath`,
			),
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
	const sha = resolveBaseSha(deps.git, callerCheckout, ref);
	const base: BatchApprovalBase = { ref, sha };

	// Bind every manifest reference AND recipe selection to its EFFECTIVE execution
	// surface: a manifest reference binds content digest (from the git tree at the
	// approved base for a repo-relative path, the filesystem for an absolute one) + safe
	// participant execution summary; a recipe binds its receipt (identity, provenance,
	// runtime defaults) AND its resolved manifest binding under the same batch/task
	// slot, so both kinds share one binding shape. Both the dry run and the confirm
	// pass through here, so an edited manifest, a redefined recipe, or a config change
	// that re-routes participants changes the hash and the confirm refuses.
	const { manifests, recipes } = resolveBatchBindings(
		normalizedTasks,
		batchManifest,
		input.recipe,
		base.sha,
		callerCheckout,
		cwd,
		deps,
	);

	// Apply the SAME defaults/caps startBatch will execute with, and bind those effective values
	// (not the raw inputs) so the operator approves what actually runs. An explicit batch
	// override beats the batch recipe's default; the engine default is the last fallback.
	// Task-level precedence (task value > task recipe default > these) is applied at launch
	// from the same hash-bound sources.
	const maxParallel = Math.max(
		1,
		Math.min(input.maxParallel ?? DEFAULT_MAX_PARALLEL, MAX_PARALLEL_CAP),
	);
	const maxIterations =
		input.maxIterations ?? recipes?.batch?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const callTimeoutMs = input.callTimeoutMs ?? recipes?.batch?.callTimeoutMs;

	const artifact = buildBatchApprovalArtifact({
		base,
		// BatchTask is structurally assignable to BatchApprovalTaskInput; its runtime-only fields
		// (status, worktreePath, ...) are ignored by the builder.
		tasks: normalizedTasks,
		maxParallel,
		maxIterations,
		...(input.recipe !== undefined && { recipe: input.recipe }),
		...(batchManifest !== undefined && { manifestPath: batchManifest }),
		...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
		...(callTimeoutMs !== undefined && { callTimeoutMs }),
		...(manifests !== undefined && { manifests }),
		...(recipes !== undefined && { recipes }),
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
			...(input.recipe !== undefined && { recipe: input.recipe }),
			...(batchManifest !== undefined && { manifestPath: batchManifest }),
			...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
			...(callTimeoutMs !== undefined && { callTimeoutMs }),
			...(manifests !== undefined && { manifests }),
			...(recipes !== undefined && { recipes }),
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
		...(input.recipe !== undefined && { recipe: input.recipe }),
		...(batchManifest !== undefined && { manifestPath: batchManifest }),
		...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
		...(callTimeoutMs !== undefined && { callTimeoutMs }),
		...(manifests !== undefined && { manifests }),
		...(recipes !== undefined && { recipes }),
	});
	return { launched: true, view: describeBatch(batch, deps), base, approvalHash: hash };
}

// Resolve the binding for the batch-level default manifest, every per-task override,
// and every recipe selection (batch-level + per-task). A direct manifest reference
// resolves to its manifest binding; a recipe resolves to its receipt (recipes record)
// AND its manifest binding (manifests record) under the same batch/task slot, so both
// kinds share one binding shape for hashing, persistence, and launch-time drift
// re-verification. Records are undefined when nothing is bound. A reference that
// cannot be resolved -- an unknown recipe, missing from the tree at the approved
// base, a symlink object, bad JSON, an unresolvable participant -- throws PlanError
// naming the surface, so a bad batch is refused at the gate like a structural
// failure. Direct manifests are skipped when the deps carry no manifest resolver
// (test harnesses; production always wires one), but a recipe-naming batch with no
// recipe resolver wired is REFUSED: silently launching without the recipe's manifest
// would run an execution surface nobody reviewed.
function resolveBatchBindings(
	tasks: BatchTask[],
	batchManifest: string | undefined,
	batchRecipe: string | undefined,
	baseSha: string,
	callerCheckout: string,
	cwd: string,
	deps: BatchEngineDeps,
): { manifests?: BatchManifestBindings; recipes?: BatchRecipeBindings } {
	const bindRecipe = (recipeId: string, context: string): ResolvedRecipe => {
		if (deps.resolveRecipe === undefined) {
			throw new PlanError(
				`${context}: recipe resolution is not available in this context; a recipe-backed batch cannot be reviewed or launched without resolving the recipe`,
			);
		}
		try {
			return deps.resolveRecipe({ recipeId, baseSha, gitCwd: callerCheckout, configCwd: cwd });
		} catch (e) {
			if (e instanceof PlanError) throw e;
			throw new PlanError(`${context}: ${(e as Error).message}`);
		}
	};
	const bindManifest = (manifestPath: string, context: string): ManifestBinding => {
		const resolveBinding = deps.resolveManifestBinding;
		if (resolveBinding === undefined) {
			throw new PlanError(`${context}: manifest binding resolution is not available`);
		}
		try {
			return resolveBinding({ manifestPath, baseSha, gitCwd: callerCheckout, configCwd: cwd });
		} catch (e) {
			throw new PlanError(`${context}: ${(e as Error).message}`);
		}
	};

	const taskBindings: Record<string, ManifestBinding> = {};
	const taskRecipes: Record<string, RecipeReceipt> = {};
	for (const t of tasks) {
		if (t.recipe !== undefined) {
			const resolved = bindRecipe(t.recipe, `task ${JSON.stringify(t.id)} recipe`);
			taskBindings[t.id] = resolved.binding;
			taskRecipes[t.id] = recipeReceiptOf(resolved);
			continue;
		}
		if (t.manifestPath === undefined || deps.resolveManifestBinding === undefined) continue;
		taskBindings[t.id] = bindManifest(t.manifestPath, `task ${JSON.stringify(t.id)} manifestPath`);
	}

	let batchBinding: ManifestBinding | undefined;
	let batchReceipt: RecipeReceipt | undefined;
	if (batchRecipe !== undefined) {
		const resolved = bindRecipe(batchRecipe, "recipe");
		batchBinding = resolved.binding;
		batchReceipt = recipeReceiptOf(resolved);
	} else if (batchManifest !== undefined && deps.resolveManifestBinding !== undefined) {
		batchBinding = bindManifest(batchManifest, "manifest_path");
	}

	const manifests: BatchManifestBindings | undefined =
		batchBinding === undefined && Object.keys(taskBindings).length === 0
			? undefined
			: {
					...(batchBinding !== undefined && { batch: batchBinding }),
					...(Object.keys(taskBindings).length > 0 && { tasks: taskBindings }),
				};
	const recipes: BatchRecipeBindings | undefined =
		batchReceipt === undefined && Object.keys(taskRecipes).length === 0
			? undefined
			: {
					...(batchReceipt !== undefined && { batch: batchReceipt }),
					...(Object.keys(taskRecipes).length > 0 && { tasks: taskRecipes }),
				};
	return {
		...(manifests !== undefined && { manifests }),
		...(recipes !== undefined && { recipes }),
	};
}

// The hash-bound receipt of a resolved recipe: identity + provenance + runtime
// defaults, WITHOUT the manifest binding (that is bound separately in the manifests
// record -- reference, not duplicate). Mirrors the plan gate's recipe record shape.
function recipeReceiptOf(resolved: ResolvedRecipe): RecipeReceipt {
	return {
		id: resolved.id,
		...(resolved.origin !== undefined && { origin: resolved.origin }),
		mode: resolved.mode,
		...(resolved.maxIterations !== undefined && { maxIterations: resolved.maxIterations }),
		...(resolved.callTimeoutMs !== undefined && { callTimeoutMs: resolved.callTimeoutMs }),
		...(resolved.description !== undefined && { description: resolved.description }),
	};
}
