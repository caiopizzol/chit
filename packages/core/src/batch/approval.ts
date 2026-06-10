// The structural approval binding for a batch. A future chit_batch_start gate runs a dry
// run first: it resolves the base ref to a concrete commit, normalizes the reviewed task
// graph, and returns an approval hash. A human reviews exactly that, and a confirmed start
// must run EXACTLY what was reviewed. To bind the approval to the work, we hash the
// canonical batch artifact -- the resolved base commit, the normalized task graph, and the
// batch-level execution knobs (maxParallel, the optional iteration budget, the default
// manifest, the chit-executed checks, and the call timeout). Anything that decides what the
// batch runs is bound, so a base, task, or knob changed after approval cannot ride an old
// hash into execution: the confirmed start re-resolves, re-normalizes, recomputes the hash,
// and refuses if it differs from the one the operator approved.
//
// This module is browser-safe (no node imports). It builds the canonical PAYLOAD only via
// the shared canonicalJson; the actual digest is computed in the CLI/MCP layer (node
// crypto), keeping core free of node dependencies. Runtime-only task fields (status,
// worktreePath, branch, jobId, result, error) are deliberately NOT bound: they are produced
// BY the run, so binding them would make the hash unstable against its own execution.

import { canonicalJson } from "../canonical-json.ts";
import type { ManifestBinding } from "../manifest/binding.ts";
import type { RequiredCheck } from "../manifest/types.ts";

// The resolved base every task worktree branches from. `ref` is what the operator (or the
// batch) asked to resolve (for display and tamper detection); `sha` is the concrete commit
// the tasks branch from, so a moved ref after approval changes the hash.
export interface BatchApprovalBase {
	ref: string;
	sha: string;
}

// The execution-deciding inputs of a single reviewed task. The shape the builder ACCEPTS:
// the full BatchTask (in the CLI layer) is structurally assignable, and its runtime-only
// fields are simply ignored. dependencies and claimedPaths are sets semantically, so the
// builder sorts them -- reordering them is not an execution change and must not move the
// hash.
export interface BatchApprovalTaskInput {
	id: string;
	title: string;
	body: string;
	dependencies: string[];
	claimedPaths: string[];
	allowPathOverlap?: boolean;
	manifestPath?: string;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
}

// A single task as bound by the approval: the normalized form of BatchApprovalTaskInput.
// dependencies and claimedPaths are sorted; optional fields are present only when set, so an
// absent field and an explicit-undefined field bind identically.
export interface BatchApprovalTask {
	id: string;
	title: string;
	body: string;
	dependencies: string[];
	claimedPaths: string[];
	allowPathOverlap?: boolean;
	manifestPath?: string;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
}

// The execution-deciding batch inputs the dry run reviews. tasks keep their list order: the
// scheduler (selectRunnable) iterates batch.tasks in order, so when a free slot or a claim
// conflict forces serialization, list order decides which task launches first. Reordering
// the list is therefore a real execution change and MUST move the hash. Optional knobs are
// included only when set, so absent and present-as-undefined bind identically.
// The EFFECTIVE execution surface of every manifest the batch references: the
// batch-level default manifest (when set) and each task override (keyed by task
// id), each bound by content digest + safe participant execution summary. Binding
// only the path string would let the manifest content or the resolved agents change
// between approval and launch without moving the hash.
export interface BatchManifestBindings {
	batch?: ManifestBinding;
	tasks?: Record<string, ManifestBinding>;
}

export interface BatchApprovalArtifact {
	strategy: "batch";
	base: BatchApprovalBase;
	tasks: BatchApprovalTask[];
	maxParallel: number;
	maxIterations?: number;
	manifestPath?: string;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
	manifests?: BatchManifestBindings;
}

export interface BatchApprovalInput {
	base: BatchApprovalBase;
	tasks: readonly BatchApprovalTaskInput[];
	maxParallel: number;
	maxIterations?: number;
	manifestPath?: string;
	requiredChecks?: RequiredCheck[];
	callTimeoutMs?: number;
	manifests?: BatchManifestBindings;
}

// Normalize one task to its execution-deciding core: keep id/title/body, sort the two set
// fields, and carry the optional overrides only when present (so undefined never perturbs
// the hash). allowPathOverlap is bound only when explicitly true -- false is the default and
// runs identically to an absent flag, so normalizing it away keeps the no-op edit hash-stable.
function normalizeTask(task: BatchApprovalTaskInput): BatchApprovalTask {
	return {
		id: task.id,
		title: task.title,
		body: task.body,
		dependencies: [...task.dependencies].sort(),
		claimedPaths: [...task.claimedPaths].sort(),
		...(task.allowPathOverlap === true && { allowPathOverlap: true }),
		...(task.manifestPath !== undefined && { manifestPath: task.manifestPath }),
		...(task.requiredChecks !== undefined && { requiredChecks: task.requiredChecks }),
		...(task.callTimeoutMs !== undefined && { callTimeoutMs: task.callTimeoutMs }),
	};
}

export function buildBatchApprovalArtifact(input: BatchApprovalInput): BatchApprovalArtifact {
	return {
		strategy: "batch",
		base: input.base,
		tasks: input.tasks.map(normalizeTask),
		maxParallel: input.maxParallel,
		...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
		...(input.manifestPath !== undefined && { manifestPath: input.manifestPath }),
		...(input.requiredChecks !== undefined && { requiredChecks: input.requiredChecks }),
		...(input.callTimeoutMs !== undefined && { callTimeoutMs: input.callTimeoutMs }),
		...(hasBindings(input.manifests) && { manifests: input.manifests }),
	};
}

// Bind manifests only when something is actually bound, so a binding-free batch
// (no manifest references, or a caller that resolved none) keeps its hash.
function hasBindings(m: BatchManifestBindings | undefined): boolean {
	if (m === undefined) return false;
	return m.batch !== undefined || Object.keys(m.tasks ?? {}).length > 0;
}

// The exact payload string the CLI/MCP layer hashes to produce a batch's approval hash.
// Stable across key order and equal for equal artifacts (see canonicalJson), so the dry-run
// hash and the confirmed-start recompute match iff the base, normalized task graph, and
// batch knobs are unchanged.
export function canonicalBatchApprovalPayload(artifact: BatchApprovalArtifact): string {
	return canonicalJson(artifact);
}
