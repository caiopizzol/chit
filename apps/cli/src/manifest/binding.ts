// Node-side manifest binding resolution: turn a manifest reference (a plan step's
// manifestPath, a batch task's / batch-level manifest_path, or a recipe's
// manifestPath) into the ManifestBinding the approval artifact hashes -- content
// digest plus safe participant execution summary -- and re-resolve the same
// reference at confirm and launch so drift is refused or paused instead of run.
//
// Read-point rules (docs/orchestration-architecture-plan.md, "Manifest digest read
// point"):
//   - A repo-relative path is read from the git TREE at the commit the run executes
//     from (`git show <sha>:<path>`), never from a caller checkout's working tree.
//     Symlink objects are rejected (mode 120000 in ls-tree), and the path must stay
//     inside the repo (no `..` escape, no absolute form smuggled in).
//   - An absolute path is operator-named (global manifests): it is read from the
//     filesystem at that exact path, at dry-run and again at confirm/launch.
//   - Any later FILESYSTEM read of a repo-relative manifest (the worker reading its
//     worktree checkout) must realpath-verify the resolved path stays under the
//     worktree root, so a symlinked path cannot escape after approval.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
	type BoundParticipantSummary,
	type ConfigOrigin,
	describeParticipantSummaryDrift,
	type ManifestBinding,
	type ManifestBindingSource,
	type NormalizedConfig,
	parseManifest,
	type RecipeMode,
	type RecipeReceipt,
	resolveManifest,
	resolveParticipantSnapshots,
} from "@chit-run/core";
import type { GitRunner } from "../batches/worktree.ts";

// A binding could not be resolved (missing/unreadable manifest, a path escaping
// the repo, a symlink object, bad JSON, or an unresolvable participant). The
// message names only what the caller already named (their path, the bound sha).
export class ManifestBindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestBindingError";
	}
}

// sha256 over the exact manifest bytes, prefixed so the algorithm is part of the
// recorded value (receipts stay self-describing if the algorithm ever changes).
export function digestManifestText(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function parseBoundManifestText(p: {
	text: string;
	expectedDigest?: string;
	retryAction: string;
	label?: string;
}): { ok: true; raw: unknown; digest: string } | { ok: false; error: string } {
	const label = p.label ?? "recipe manifest";
	const digest = digestManifestText(p.text);
	if (p.expectedDigest !== undefined && digest !== p.expectedDigest) {
		return {
			ok: false,
			error: `${label} no longer matches the approved content (approved ${p.expectedDigest}, found ${digest}); the execution surface changed after approval, so the run is refused -- ${p.retryAction}`,
		};
	}
	try {
		return { ok: true, raw: JSON.parse(p.text), digest };
	} catch (e) {
		return { ok: false, error: `${label} is not valid JSON: ${(e as Error).message}` };
	}
}

export function verifyBoundManifestParticipants(p: {
	raw: unknown;
	config: NormalizedConfig;
	expectedParticipants?: Record<string, BoundParticipantSummary>;
	retryAction: string;
}): { ok: true } | { ok: false; error: string } {
	if (p.expectedParticipants === undefined) return { ok: true };
	let currentParticipants: Record<string, BoundParticipantSummary>;
	try {
		currentParticipants = resolveManifestParticipantSummary(p.raw, p.config);
	} catch (e) {
		return {
			ok: false,
			error: `could not resolve manifest participant summary: ${(e as Error).message}`,
		};
	}
	const drift = describeParticipantSummaryDrift(p.expectedParticipants, currentParticipants);
	if (drift !== undefined) {
		return {
			ok: false,
			error: `manifest participant execution drift detected before execution: ${drift}. The run was refused instead of silently using a different agent/model/permission surface; ${p.retryAction}.`,
		};
	}
	return { ok: true };
}

// The normalized identity of a manifest reference: an absolute path stays itself
// (source "file"); a relative path is resolved against `cwd` and re-expressed
// repo-root-relative in posix form (source "git"), rejecting anything that escapes
// the repo. The repo-relative form is what the approval binds AND what the worker
// later resolves against its worktree root, so the two read the same tree path.
export function normalizeManifestReference(
	manifestPath: string,
	cwd: string,
	repoRoot: string,
): { manifestPath: string; source: ManifestBindingSource } {
	if (manifestPath.trim() === "") {
		throw new ManifestBindingError("manifest path is empty");
	}
	if (isAbsolute(manifestPath)) {
		return { manifestPath: normalize(manifestPath), source: "file" };
	}
	const abs = resolve(cwd, manifestPath);
	const rel = relative(repoRoot, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new ManifestBindingError(
			`manifest path ${JSON.stringify(manifestPath)} escapes the repo; a repo-relative manifest must stay inside the repo (use an absolute path for a manifest outside it)`,
		);
	}
	return { manifestPath: rel.split(sep).join("/"), source: "git" };
}

// Read the bound manifest bytes from the read point its source dictates: the git
// tree at `baseSha` for a repo-relative reference (rejecting symlink objects and
// missing paths), or the filesystem for an absolute one.
export function readBoundManifestText(
	ref: { manifestPath: string; source: ManifestBindingSource },
	p: { git: GitRunner; gitCwd: string; baseSha: string },
): string {
	if (ref.source === "file") {
		try {
			return readFileSync(ref.manifestPath, "utf-8");
		} catch (e) {
			throw new ManifestBindingError(
				`could not read manifest at ${ref.manifestPath}: ${(e as Error).message}`,
			);
		}
	}
	// Repo-relative: read the git BLOB at the bound commit. ls-tree first, so a
	// symlink object (mode 120000) is rejected before any content read -- reading a
	// blob directly never follows filesystem symlinks, but a symlink OBJECT's blob
	// is its target path, which must never be treated as manifest content.
	const ls = p.git(["ls-tree", p.baseSha, "--", ref.manifestPath], p.gitCwd);
	if (ls.code !== 0) {
		throw new ManifestBindingError(
			`could not inspect ${ref.manifestPath} in the git tree at ${p.baseSha}: ${(ls.stderr || ls.stdout).trim()}`,
		);
	}
	const entry = ls.stdout.trim();
	if (entry === "") {
		throw new ManifestBindingError(
			`no ${ref.manifestPath} in the git tree at ${p.baseSha}; a repo-relative manifest is read from the commit the run executes from, not the working tree -- commit the manifest, or pass an absolute path for a file outside version control`,
		);
	}
	const mode = entry.split(/\s+/, 1)[0];
	if (mode === "120000") {
		throw new ManifestBindingError(
			`${ref.manifestPath} is a symlink in the git tree at ${p.baseSha}; a repo-relative manifest must be a regular file (symlinks could point outside the repo)`,
		);
	}
	const show = p.git(["show", `${p.baseSha}:${ref.manifestPath}`], p.gitCwd);
	if (show.code !== 0) {
		throw new ManifestBindingError(
			`could not read ${ref.manifestPath} from the git tree at ${p.baseSha}: ${(show.stderr || show.stdout).trim()}`,
		);
	}
	return show.stdout;
}

// What a binding resolution needs from its call site. `manifestPath` is the
// reference AS BOUND: repo-root-relative (posix) or absolute -- callers normalize
// raw operator input with normalizeManifestReference first. `baseSha` is the
// commit the run executes from (the git-tree read point for a repo-relative path);
// `gitCwd` is any checkout of the repo (object reads only); `configCwd` is the
// checkout config layering resolves from (the launching checkout, matching the
// worker's own config read).
export interface ManifestBindingRequest {
	manifestPath: string;
	baseSha: string;
	gitCwd: string;
	configCwd: string;
}

// The injectable dep shape the plan/batch engines and gates share: resolve the
// CURRENT binding for a reference, throwing ManifestBindingError when it cannot be
// resolved. The real implementation loads fresh config per call (the worker does
// too), so config drift between approval and launch surfaces as binding drift.
export type ResolveManifestBinding = (p: ManifestBindingRequest) => ManifestBinding;

// Resolve one manifest reference into its binding: read the bytes from the right
// read point, digest them, parse + resolve participants against the given config,
// and build the safe execution summary (the audit snapshot shape -- envKeys only,
// never env values, prompts, or outputs -- plus role and config-layer provenance).
export function resolveManifestBindingWith(
	req: ManifestBindingRequest,
	deps: { git: GitRunner; config: NormalizedConfig },
): ManifestBinding {
	const source: ManifestBindingSource = isAbsolute(req.manifestPath) ? "file" : "git";
	const ref = { manifestPath: req.manifestPath, source };
	const text = readBoundManifestText(ref, {
		git: deps.git,
		gitCwd: req.gitCwd,
		baseSha: req.baseSha,
	});

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new ManifestBindingError(
			`manifest ${ref.manifestPath} is not valid JSON: ${(e as Error).message}`,
		);
	}
	let participants: Record<string, BoundParticipantSummary>;
	try {
		participants = resolveManifestParticipantSummary(raw, deps.config);
	} catch (e) {
		throw new ManifestBindingError(`manifest ${ref.manifestPath}: ${(e as Error).message}`);
	}

	return {
		manifestPath: ref.manifestPath,
		source,
		manifestDigest: digestManifestText(text),
		participants,
	};
}

export function resolveManifestParticipantSummary(
	raw: unknown,
	config: NormalizedConfig,
): Record<string, BoundParticipantSummary> {
	const resolved = resolveManifest(parseManifest(raw), { roles: config.roles });
	const snapshots = resolveParticipantSnapshots(resolved, config.registry);
	const participants: Record<string, BoundParticipantSummary> = {};
	for (const [pid, snapshot] of Object.entries(snapshots)) {
		const role = resolved.participants[pid]?.provenance.role;
		const agentOrigin = config.provenance?.agents[snapshot.agentId]?.source;
		participants[pid] = {
			...snapshot,
			...(role !== undefined && { role }),
			...(agentOrigin !== undefined && { agentOrigin }),
		};
	}
	return participants;
}

// --- filesystem read guard (worker / launch validation) ---------------------

// Resolve a job's manifest path for a FILESYSTEM read, rejecting symlink escapes
// for relative (repo-relative) paths: realpath the resolved path and require it to
// stay under the realpath of the root it resolves against (the run's worktree).
// An absolute path is operator-named and returned as-is.
export function resolveJobManifestPath(manifestPath: string, cwd: string): string {
	if (isAbsolute(manifestPath)) return manifestPath;
	const abs = resolve(cwd, manifestPath);
	let real: string;
	let rootReal: string;
	try {
		real = realpathSync(abs);
		rootReal = realpathSync(cwd);
	} catch (e) {
		throw new ManifestBindingError(`could not resolve manifest at ${abs}: ${(e as Error).message}`);
	}
	if (real !== rootReal && !real.startsWith(rootReal + sep)) {
		throw new ManifestBindingError(
			`manifest path ${JSON.stringify(manifestPath)} resolves outside ${cwd} (a symlink or traversal escape); a repo-relative manifest must stay inside the repo`,
		);
	}
	return real;
}

// Read a run's manifest from the filesystem with the symlink-escape guard and,
// when the run carries an approved digest, verify the bytes still match it. Result
// shape (never throws) because both call sites -- launch validation and the
// detached worker -- report failures through their own error channels.
export function readJobManifest(p: {
	manifestPath: string;
	cwd: string;
	expectedDigest?: string;
}): { ok: true; raw: unknown; path: string; digest: string } | { ok: false; error: string } {
	let path: string;
	try {
		path = resolveJobManifestPath(p.manifestPath, p.cwd);
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (e) {
		return { ok: false, error: `could not read manifest at ${path}: ${(e as Error).message}` };
	}
	const digest = digestManifestText(text);
	if (p.expectedDigest !== undefined && digest !== p.expectedDigest) {
		return {
			ok: false,
			error: `manifest at ${path} no longer matches the approved content (approved ${p.expectedDigest}, found ${digest}); the execution surface changed after approval, so the run is refused -- re-run the dry run and re-approve`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: `manifest at ${path} is not valid JSON: ${(e as Error).message}` };
	}
	return { ok: true, raw, path, digest };
}

// --- recipe resolution substrate -------------------------------------------

// A config recipe resolved to its effective execution surface: identity +
// provenance + mode + runtime defaults + the manifest binding (digest + safe
// participant summary). Plan-step `recipe` binds this into the plan approval
// artifact at the chit_plan_start gate; batch-level and batch-task `recipe` bind
// it the same way at the chit_batch_start gate.
export interface ResolvedRecipe {
	id: string;
	origin?: ConfigOrigin;
	mode: RecipeMode;
	binding: ManifestBinding;
	maxIterations?: number;
	callTimeoutMs?: number;
	description?: string;
}

// What a recipe resolution needs from its call site, mirroring
// ManifestBindingRequest: the recipe id, the commit the run executes from (the
// git-tree read point for a repo-relative recipe manifest), any checkout of the
// repo for object reads, and the checkout config layering resolves from.
export interface RecipeResolutionRequest {
	recipeId: string;
	baseSha: string;
	gitCwd: string;
	configCwd: string;
}

// The injectable dep shape the plan and batch gates use to resolve a recipe,
// mirroring ResolveManifestBinding: the real implementation loads fresh config per
// call, so a recipe redefined between dry run and confirm surfaces as a hash
// mismatch instead of being pinned away. Throws ManifestBindingError when the
// recipe or its manifest cannot be resolved.
export type ResolveRecipe = (p: RecipeResolutionRequest) => ResolvedRecipe;

// Resolve a recipe id against the effective config: look it up, normalize its
// manifest reference (repo recipes are parser-confined to repo-relative paths;
// global recipes may be absolute), and bind the manifest content + participants
// from the read point `baseSha` dictates.
export function resolveRecipe(
	id: string,
	config: NormalizedConfig,
	ctx: { git: GitRunner; repoRoot: string; baseSha: string },
): ResolvedRecipe {
	const recipe = config.recipes[id];
	if (recipe === undefined) {
		const known = Object.keys(config.recipes).sort();
		throw new ManifestBindingError(
			`unknown recipe ${JSON.stringify(id)}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (no recipes are configured)"}`,
		);
	}
	const ref = normalizeManifestReference(recipe.manifestPath, ctx.repoRoot, ctx.repoRoot);
	const binding = resolveManifestBindingWith(
		{
			manifestPath: ref.manifestPath,
			baseSha: ctx.baseSha,
			gitCwd: ctx.repoRoot,
			configCwd: ctx.repoRoot,
		},
		{ git: ctx.git, config },
	);
	return {
		id,
		...(config.provenance?.recipes[id] !== undefined && {
			origin: config.provenance.recipes[id],
		}),
		mode: recipe.mode,
		binding,
		...(recipe.mode === "converge" &&
			recipe.maxIterations !== undefined && { maxIterations: recipe.maxIterations }),
		...(recipe.mode === "converge" &&
			recipe.callTimeoutMs !== undefined && { callTimeoutMs: recipe.callTimeoutMs }),
		...(recipe.description !== undefined && { description: recipe.description }),
	};
}

// The hash-bound receipt of a resolved recipe: identity + provenance + runtime
// defaults, WITHOUT the manifest binding (that is referenced separately in a
// manifests record -- reference, not duplicate). Single-sources the
// ResolvedRecipe -> RecipeReceipt mapping the plan gate, the batch gate, and a
// recipe-backed chit_start all stamp.
export function recipeReceiptOf(resolved: ResolvedRecipe): RecipeReceipt {
	return {
		id: resolved.id,
		...(resolved.origin !== undefined && { origin: resolved.origin }),
		mode: resolved.mode,
		...(resolved.maxIterations !== undefined && { maxIterations: resolved.maxIterations }),
		...(resolved.callTimeoutMs !== undefined && { callTimeoutMs: resolved.callTimeoutMs }),
		...(resolved.description !== undefined && { description: resolved.description }),
	};
}
