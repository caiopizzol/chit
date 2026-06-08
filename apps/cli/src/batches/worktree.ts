// Git worktree management for batch tasks: one isolated worktree + branch per
// task, created off the batch's resolved base SHA so every task starts from
// the same point. Conservative by design and with an injectable GitRunner so the
// engine is testable without touching real git. Salvaged from the batch-v0
// prototype; the worktree path is the agreed v1 layout.
//
// Worktrees are NEVER auto-removed: they ARE the review artifacts a human
// inspects after the batch. Cleanup is a separate, explicit step.

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { formatDuration } from "../jobs/health.ts";

export class WorktreeError extends Error {}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitResult;

export const realGit: GitRunner = (args, cwd) => {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (e) {
		const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
		return {
			code: typeof err.status === "number" ? err.status : 1,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? ""),
		};
	}
};

function gitErr(r: GitResult): string {
	return (r.stderr || r.stdout || `exit ${r.code}`).trim();
}

// A managed worktree links the launching checkout's node_modules as a SYMLINK (see linkNodeModules).
// The conventional directory-only `node_modules/` gitignore pattern does NOT match a symlink, so git
// reports the link as untracked. node_modules is tooling, never applicable work, so it is filtered
// from a run's apply candidates and partial-work listings -- otherwise the linked symlink would read
// as an untracked file to apply or as uncommitted work. Matches the top-level tooling link this
// helper creates, plus any path beneath it.
function isLinkedToolingPath(p: string): boolean {
	return p === "node_modules" || p.startsWith("node_modules/");
}

// Where a task's worktree and branch live. The agreed v1 layout:
//   ~/worktrees/chit/<batchId>/<taskId>   (absolute, recorded in state)
//   branch: chit-batch/<batchId>/<taskId>
export function taskWorktree(
	batchId: string,
	taskId: string,
): { worktreePath: string; branch: string } {
	return {
		worktreePath: join(homedir(), "worktrees", "chit", batchId, taskId),
		branch: `chit-batch/${batchId}/${taskId}`,
	};
}

// Resolve a ref (branch/SHA) to a concrete commit SHA in the repo, so every task
// branches from one fixed base even if the repo's HEAD moves mid-batch.
export function resolveBaseSha(git: GitRunner, repo: string, ref: string): string {
	const r = git(["rev-parse", ref], repo);
	if (r.code !== 0) {
		throw new WorktreeError(`cannot resolve base ref ${JSON.stringify(ref)}: ${gitErr(r)}`);
	}
	return r.stdout.trim();
}

// The repo's top-level path, so a batch started from a subdir still creates
// worktrees against the real repo root.
export function repoToplevel(git: GitRunner, cwd: string): string {
	const r = git(["rev-parse", "--show-toplevel"], cwd);
	if (r.code !== 0) {
		throw new WorktreeError(`not a git repository at ${JSON.stringify(cwd)}: ${gitErr(r)}`);
	}
	return r.stdout.trim();
}

// Link an existing node_modules from a source checkout into a freshly created managed worktree.
// A managed worktree is a FRESH git worktree: it has the committed tree but NOT untracked workspace
// tooling like node_modules, so a check that shells out to an installed binary (e.g. a `bun --filter
// ... typecheck` that runs fumadocs-mdx / biome) fails with a mystery "command not found" even though
// the launching checkout has dependencies installed. Symlink (not copy) the source's node_modules so
// the worktree shares the SAME installed tooling without duplicating it on disk. We do NOT run an
// install: the link reuses what the source already has. Conservative:
//   - no-op when the source has no node_modules (nothing to share), and
//   - never clobber an existing target node_modules (lstat so a dangling symlink still counts present).
// A link failure surfaces a WorktreeError so a check fails loudly HERE, not later with a missing-binary
// mystery. Note: a project's conventional directory-only `node_modules/` ignore does NOT match a
// symlink, so git reports the link as untracked -- callers that read a worktree's untracked/dirty
// state filter it via isLinkedToolingPath, and it is never linked into a worktree that is committed.
export function linkNodeModules(sourceCheckout: string, targetWorktree: string): void {
	const src = join(sourceCheckout, "node_modules");
	const dst = join(targetWorktree, "node_modules");
	if (!existsSync(src)) return; // the source has no installed deps to share
	// lstat, not existsSync: a dangling symlink at dst must still count as present (never clobber it).
	let dstPresent = true;
	try {
		lstatSync(dst);
	} catch {
		dstPresent = false;
	}
	if (dstPresent) return; // never overwrite an existing install/link
	try {
		// Absolute target so the link resolves regardless of the worktree's own location.
		symlinkSync(src, dst);
	} catch (e) {
		throw new WorktreeError(
			`could not link node_modules from ${src} into ${dst}: ${(e as Error).message}`,
		);
	}
}

function excludeLinkedNodeModules(git: GitRunner, worktreePath: string): void {
	const r = git(["rev-parse", "--git-common-dir"], worktreePath);
	if (r.code !== 0) {
		throw new WorktreeError(
			`could not find git common dir for linked node_modules exclude in ${worktreePath}: ${gitErr(r)}`,
		);
	}
	const raw = r.stdout.trim();
	const gitCommonDir = resolve(worktreePath, raw);
	const excludePath = join(gitCommonDir, "info", "exclude");
	mkdirSync(dirname(excludePath), { recursive: true });
	const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
	if (current.split(/\r?\n/).includes("/node_modules")) return;
	appendFileSync(
		excludePath,
		`${current.endsWith("\n") || current.length === 0 ? "" : "\n"}/node_modules\n`,
	);
}

// Create a worktree + branch off baseSha at an explicit path/branch. Conservative:
// refuses if the branch or the worktree path already exists (never clobbers prior
// work). `git worktree add -b` creates the leaf dir but not missing parents, so the
// parent is created first. The generic core shared by batch tasks and single runs.
// When `toolingSource` is given, its node_modules is linked into the fresh worktree
// (see linkNodeModules) so checks can resolve installed binaries the worktree lacks; a
// link failure rolls back the just-created worktree + branch so nothing is orphaned.
export function createWorktree(
	git: GitRunner,
	repo: string,
	worktreePath: string,
	branch: string,
	baseSha: string,
	toolingSource?: string,
): { worktreePath: string; branch: string } {
	if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).code === 0) {
		throw new WorktreeError(`branch ${JSON.stringify(branch)} already exists`);
	}
	if (existsSync(worktreePath)) {
		throw new WorktreeError(`worktree path already exists: ${worktreePath}`);
	}

	mkdirSync(dirname(worktreePath), { recursive: true });
	const r = git(["worktree", "add", "-b", branch, worktreePath, baseSha], repo);
	if (r.code !== 0) {
		throw new WorktreeError(`git worktree add failed: ${gitErr(r)}`);
	}
	if (toolingSource !== undefined) {
		try {
			linkNodeModules(toolingSource, worktreePath);
			if (existsSync(join(worktreePath, "node_modules"))) {
				// Keep agent-visible `git status` clean too: a directory-only `node_modules/` ignore
				// pattern does not ignore this symlink, so add a repo-local exclude.
				excludeLinkedNodeModules(git, worktreePath);
			}
		} catch (e) {
			// Atomic: the worktree + branch already exist, but callers record worktreePath/branch only
			// AFTER this returns -- so a post-add setup failure would strand them outside cleanup. Roll
			// back the just-created worktree + branch (best-effort), then rethrow the original error so
			// the caller still fails loudly without leaving an orphan.
			removeTaskWorktree(git, repo, worktreePath, branch);
			throw e;
		}
	}
	return { worktreePath, branch };
}

// Batch wrapper: a task's worktree at the batch layout. Behavior-identical to the
// generic createWorktree at taskWorktree(batchId, taskId)'s path/branch.
export function createTaskWorktree(
	git: GitRunner,
	repo: string,
	batchId: string,
	taskId: string,
	baseSha: string,
	toolingSource?: string,
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = taskWorktree(batchId, taskId);
	return createWorktree(git, repo, worktreePath, branch, baseSha, toolingSource);
}

// Where a plan's integration worktree + branch live: the plan's accumulating result,
// cut from the plan base and advanced one commit per applied step. A sibling of the
// step worktrees (under steps/) so a step id of "integration" can never collide:
//   ~/worktrees/chit/<planId>/integration
//   branch: chit-plan/<planId>/integration
export function planIntegrationWorktree(planId: string): { worktreePath: string; branch: string } {
	return {
		worktreePath: join(homedir(), "worktrees", "chit", planId, "integration"),
		branch: `chit-plan/${planId}/integration`,
	};
}

// Where one plan step's worktree + branch live, cut from the integration tip. Nested
// under steps/ so the branch namespace is disjoint from the integration branch:
//   ~/worktrees/chit/<planId>/steps/<stepId>
//   branch: chit-plan/<planId>/steps/<stepId>
export function planStepWorktree(
	planId: string,
	stepId: string,
): { worktreePath: string; branch: string } {
	return {
		worktreePath: join(homedir(), "worktrees", "chit", planId, "steps", stepId),
		branch: `chit-plan/${planId}/steps/${stepId}`,
	};
}

// Plan wrappers: create the integration / a step worktree at the plan layout, off the
// given base SHA. Behavior-identical to createWorktree at the plan paths/branches.
//
// The integration worktree is DELIBERATELY not given a tooling link: it never runs project
// checks (it only `git apply`s a step's diff and `git commit`s it), and a node_modules symlink
// there would be staged by commitWorktree's `git add -A` (the conventional directory-only
// `node_modules/` ignore does not match a symlink) -- committing tooling into the integration
// branch and dirtying the clean-worktree apply gate. Only the step worktrees, where checks run,
// link tooling (see createPlanStepWorktree). The integration commit hook problem is handled by
// commitWorktree's --no-verify, not by tooling.
export function createPlanIntegrationWorktree(
	git: GitRunner,
	repo: string,
	planId: string,
	baseSha: string,
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = planIntegrationWorktree(planId);
	return createWorktree(git, repo, worktreePath, branch, baseSha);
}

// A step worktree DOES link tooling: the converge loop runs the step's checks here (cwd is this
// worktree), so without the launching checkout's node_modules a check shelling out to an installed
// binary fails with a missing-binary error. node_modules is filtered from this worktree's apply
// candidates / partial work (see applyRunWorkspace / inspectPartialWork) so the un-ignored symlink
// never reads as applicable work.
export function createPlanStepWorktree(
	git: GitRunner,
	repo: string,
	planId: string,
	stepId: string,
	baseSha: string,
	toolingSource?: string,
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = planStepWorktree(planId, stepId);
	return createWorktree(git, repo, worktreePath, branch, baseSha, toolingSource);
}

// Make a scope safe as a git branch component and a path leaf: lowercase, runs of
// non-alphanumerics collapse to a single hyphen, trimmed; empty falls back to "run".
function slugify(scope: string): string {
	const slug = scope
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "run";
}

// Where a single run's managed worktree + branch live, parallel to taskWorktree:
//   <root>/<runId>/<scope-slug>            (root defaults to ~/worktrees/chit)
//   branch: chit-run/<runId>/<scope-slug>
// Deterministic so a human (or supervising agent) can find the run's diff.
export function runWorktree(
	runId: string,
	scope: string,
	root: string = join(homedir(), "worktrees", "chit"),
): { worktreePath: string; branch: string } {
	const slug = slugify(scope);
	return { worktreePath: join(root, runId, slug), branch: `chit-run/${runId}/${slug}` };
}

// The shared run-workspace primitive for write-capable loop runs, used by BOTH the
// foreground and background paths (Slice B wires it in; this slice only adds + tests
// it, no behavior change). It isolates the run in a managed worktree cut clean off
// baseSha, so the run's diff is attributable no matter how dirty the caller's tree is
// (that is the point -- the caller tree's state does not matter). `inPlace` opts OUT,
// running in the caller's checkout (only when edits are intentionally wanted there).
// One-shot / read-only runs do not call this. The worktree is NEVER auto-removed (it
// IS the review artifact); `cleanup` is returned for an explicit later step.
export function prepareRunWorkspace(
	git: GitRunner,
	callerCwd: string,
	opts: {
		runId: string;
		scope: string;
		inPlace?: boolean;
		baseRef?: string;
		worktreesRoot?: string;
	},
): {
	cwd: string;
	worktreePath?: string;
	branch?: string;
	baseSha?: string;
	repo?: string;
	callerCheckout?: string;
	cleanup?: () => void;
} {
	if (opts.inPlace) return { cwd: callerCwd };
	// The DURABLE common/main repo (NOT repoToplevel: if the caller runs from a linked worktree,
	// repoToplevel is that linked checkout, which may later be removed -- cleanup must anchor on
	// the main repo that owns the shared .git). mainRepoOfWorktree resolves it for both a main-repo
	// caller and a linked-worktree caller. baseSha still comes from the caller's HEAD (the state
	// the user expects the run to branch from), resolved from callerCwd; the commit lives in the
	// shared object store, so the main repo can cut a worktree at it.
	const repo = mainRepoOfWorktree(git, callerCwd);
	const baseSha = resolveBaseSha(git, callerCwd, opts.baseRef ?? "HEAD");
	// The LAUNCHING checkout: the work tree root the user ran chit from (a linked worktree, or the
	// main repo). DISTINCT from `repo`: when launched from a linked worktree, callerCheckout is that
	// worktree while repo is the durable main repo. chit_apply defaults its target here (where the
	// user is working); cleanup still anchors on repo. repoToplevel resolves the caller's own work
	// tree root (so a run launched from a subdir applies at the checkout root).
	const callerCheckout = repoToplevel(git, callerCwd);
	const { worktreePath, branch } = runWorktree(opts.runId, opts.scope, opts.worktreesRoot);
	// Link the launching checkout's node_modules into the fresh worktree so a write run's checks
	// resolve installed binaries the worktree itself lacks (see linkNodeModules). A no-op when the
	// launching checkout has none.
	createWorktree(git, repo, worktreePath, branch, baseSha, callerCheckout);
	return {
		cwd: worktreePath,
		worktreePath,
		branch,
		baseSha,
		// The main repo, recorded so cleanup runs git worktree remove / branch -D from here even
		// after the worktree dir is gone -- no fragile re-derivation from a missing worktree.
		repo,
		callerCheckout,
		// removeTaskWorktree is the generic path+branch remover (force-remove + branch -D),
		// safe for a run worktree too. Never auto-called: the caller cleans up explicitly.
		cleanup: () => {
			removeTaskWorktree(git, repo, worktreePath, branch);
		},
	};
}

// Best-effort removal of a now-empty directory -- a retired worktree's parent (chit/<batchId>,
// chit/<runId>) or a plan's worktree root (chit/<planId>) -- so cleanup leaves no empty litter.
// rmdir removes ONLY an empty directory: it fails (returns false, never throws) on a non-empty one
// or a missing path, so this can neither delete real contents nor escape the directory it is given.
// Returns whether the directory was actually removed.
export function removeEmptyDir(dir: string): boolean {
	try {
		rmdirSync(dir);
		return true;
	} catch {
		// non-empty (siblings remain) or already gone -- leave it
		return false;
	}
}

// The result of removeTaskWorktree, named so the engine deps that wrap it can be typed without
// re-spelling the union.
export type RemoveWorktreeResult =
	| { ok: true; removedWorktree: boolean; removedBranch: boolean }
	| { ok: false; error: string };

export interface CommitResult {
	committed: boolean; // false when there was nothing to commit (no diff); not an error
	sha?: string; // the worktree's HEAD after the call (the new commit, or the unchanged tip on a no-op)
	error?: string; // set when add/commit/HEAD resolution failed
}

// Stage everything in a worktree and commit it with `message`, returning the resulting HEAD sha.
// Used by the plan apply gate to turn an applied step diff into a step-scoped commit on the
// integration branch. `git add -A` stages BOTH the tracked patch (already staged by git apply
// --3way) and the copied untracked files, so the commit includes the whole applied result.
// Deliberately does NOT create an empty commit: when nothing is staged (the step produced no
// diff), it returns committed=false with the unchanged HEAD, so the caller can record a coherent
// no-op (the tip does not move) instead of an empty commit. Pure over the GitRunner (testable
// against a real or fake git).
export function commitWorktree(
	git: GitRunner,
	worktreePath: string,
	message: string,
): CommitResult {
	const add = git(["add", "-A"], worktreePath);
	if (add.code !== 0) return { committed: false, error: `git add -A failed: ${gitErr(add)}` };
	// `git diff --cached --quiet` exits 0 when nothing is staged, 1 when there are staged changes.
	const staged = git(["diff", "--cached", "--quiet"], worktreePath);
	const head = (): CommitResult => {
		const h = git(["rev-parse", "HEAD"], worktreePath);
		if (h.code !== 0) return { committed: false, error: `git rev-parse HEAD failed: ${gitErr(h)}` };
		return { committed: false, sha: h.stdout.trim() };
	};
	if (staged.code === 0) return head(); // nothing to commit: no-op, report the unchanged tip
	// --no-verify: these are INTERNAL plan integration commits in a disposable worktree, not the
	// operator's final commit. A managed worktree has no project tool PATH, so a project pre-commit
	// hook (e.g. one that runs biome directly) would fail there on missing tooling. Validation is the
	// Chit-required checks plus the operator's final commit in their own checkout, so the integration
	// step commit must not depend on disposable-worktree hook tooling.
	const commit = git(["commit", "--no-verify", "-m", message], worktreePath);
	if (commit.code !== 0) return { committed: false, error: `git commit failed: ${gitErr(commit)}` };
	const h = head();
	return h.error ? h : { committed: true, sha: h.sha };
}

// Retire a task's worktree + branch. Used by chit_batch_cleanup AFTER the
// human is done reviewing: the converged diff lives uncommitted in the worktree,
// so removal is destructive of that diff -- the caller gates this behind an
// explicit confirm and a dry-run. `--force` is required precisely because the
// worktree is expected to be dirty (the diff); branch -D because the diff was
// never committed (the branch sits at base). Best-effort and idempotent: a
// missing worktree/branch is not an error (already cleaned).
export function removeTaskWorktree(
	git: GitRunner,
	repo: string,
	worktreePath: string,
	branch: string,
): RemoveWorktreeResult {
	// Report WHAT was actually removed (vs already gone), so callers can give an honest
	// idempotent response instead of claiming a removal that did nothing.
	let removedWorktree = false;
	if (existsSync(worktreePath)) {
		const r = git(["worktree", "remove", "--force", worktreePath], repo);
		if (r.code !== 0) return { ok: false, error: `git worktree remove failed: ${gitErr(r)}` };
		removedWorktree = true;
	} else {
		// The worktree dir is gone but git may still track it; prune stale entries.
		git(["worktree", "prune"], repo);
	}
	let removedBranch = false;
	if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).code === 0) {
		const b = git(["branch", "-D", branch], repo);
		if (b.code !== 0) return { ok: false, error: `git branch -D failed: ${gitErr(b)}` };
		removedBranch = true;
	}
	// Best-effort: drop the now-empty <id> parent (chit/<batchId> or chit/<runId>) so a removed
	// worktree leaves no litter. Empty-only: a parent that still holds sibling worktrees is left.
	removeEmptyDir(dirname(worktreePath));
	return { ok: true, removedWorktree, removedBranch };
}

// The MAIN repo a linked worktree belongs to. A worktree's own `rev-parse --show-toplevel`
// is the worktree itself, but `git worktree remove` must run from the MAIN repo (git refuses
// to remove the current working tree), so resolve it via the shared git common dir:
// <main>/.git -> <main>. `--git-common-dir` may be relative to the worktree, so resolve it.
// Assumes a non-bare main repo (its common dir is <main>/.git) -- always true for chit, whose
// worktrees are only ever cut from a working checkout (a bare repo has no working tree to run in).
export function mainRepoOfWorktree(git: GitRunner, worktreePath: string): string {
	const r = git(["rev-parse", "--git-common-dir"], worktreePath);
	if (r.code !== 0) {
		throw new WorktreeError(
			`cannot resolve the main repo for worktree ${JSON.stringify(worktreePath)}: ${gitErr(r)}`,
		);
	}
	// --git-common-dir is relative for a main repo (".git") but absolute+realpath'd for a linked
	// worktree; canonicalize so the stored repo is consistent regardless. realpathSync needs the
	// path to exist (true for a real repo); a fake/scripted path falls back to the joined value.
	const main = dirname(resolve(worktreePath, r.stdout.trim()));
	try {
		return realpathSync(main);
	} catch {
		return main;
	}
}

export interface RunCleanupResult {
	confirmed: boolean; // false = dry run (nothing removed)
	worktreePath?: string;
	branch?: string;
	removed?: boolean; // set on confirm: did THIS call actually retire the worktree/branch
	alreadyRemoved?: boolean; // set on confirm: nothing to do, it was already gone (idempotent re-run)
	error?: string;
	receiptsKept: true; // cleanup NEVER deletes the loop log / audit records
	note: string;
}

// Retire ONE run's managed worktree + branch (#98), the single-run analog of cleanupBatch.
// Default is a DRY RUN (confirm=false): reports what would be removed, removes nothing. With
// confirm=true it removes the worktree + branch (and the now-empty parent) via removeTaskWorktree.
// NEVER deletes receipts (loop log / audit) -- those stay as history. A run with no managed
// worktree (an in_place run) is a no-op. The CALLER must ensure the run is terminal (no live
// worker) before confirming: removing a worktree from under a live worker corrupts the run.
export function cleanupRunWorkspace(
	git: GitRunner,
	opts: { repo: string; worktreePath?: string; branch?: string; confirm: boolean },
): RunCleanupResult {
	if (!opts.worktreePath || !opts.branch) {
		return {
			confirmed: opts.confirm,
			receiptsKept: true,
			note: "this run has no chit-managed worktree (it ran in_place); nothing to clean.",
		};
	}
	if (!opts.confirm) {
		return {
			confirmed: false,
			worktreePath: opts.worktreePath,
			branch: opts.branch,
			receiptsKept: true,
			note: `dry run: would remove the worktree (${opts.worktreePath}) + branch (${opts.branch}), discarding its uncommitted diff. Receipts (loop log / audit) are kept. Pass confirm=true to remove.`,
		};
	}
	const r = removeTaskWorktree(git, opts.repo, opts.worktreePath, opts.branch);
	if (!r.ok) {
		return {
			confirmed: true,
			worktreePath: opts.worktreePath,
			branch: opts.branch,
			removed: false,
			error: r.error,
			receiptsKept: true,
			note: `failed to remove the worktree: ${r.error}`,
		};
	}
	// Honest idempotency: report removed ONLY when this call actually retired something; a re-run
	// (worktree + branch already gone) reports alreadyRemoved, not a phantom removal.
	const didRemove = r.removedWorktree || r.removedBranch;
	return {
		confirmed: true,
		worktreePath: opts.worktreePath,
		branch: opts.branch,
		removed: didRemove,
		...(didRemove ? {} : { alreadyRemoved: true }),
		receiptsKept: true,
		note: didRemove
			? "removed the worktree + branch. Receipts (loop log / audit) are kept."
			: "already removed; nothing to do. Receipts (loop log / audit) are kept.",
	};
}

export interface RunApplyResult {
	confirmed: boolean; // false = dry run (nothing applied)
	target: string;
	trackedFiles: string[]; // files in the run's tracked diff (baseSha -> worktree)
	appliesClean: boolean; // does that patch apply to the target (git apply --check --3way)?
	applied?: boolean; // set on confirm: was the tracked patch actually applied
	conflict?: string; // when !appliesClean: git's conflict report (no markers are written)
	untracked: string[]; // unignored untracked candidates in the worktree -- NOT applied unless included
	untrackedConflicts: string[]; // requested untracked files that already exist in the target with DIFFERENT content (would overwrite -> refused)
	// Set on a DRY RUN when include_untracked was passed: the requested files that WOULD be copied on
	// confirm (requested AND a real candidate AND not a conflict). Surfaces both what the request
	// selected and what it silently missed (a typo / already-tracked name is just absent here).
	wouldApplyUntracked?: string[];
	appliedUntracked?: string[]; // set on confirm: which untracked files were copied (a subset of `untracked`)
	receiptsKept: true; // apply NEVER touches the loop log / audit
	note: string;
}

// Apply ONE finished run's diff back to a working checkout (#101). The run's work lives
// UNCOMMITTED in its managed worktree, so the patch is `git diff baseSha` from the worktree.
// Dry-run by default (confirm=false): report whether it applies + the untracked candidates,
// change nothing. The conflict gate is git's own `apply --check --3way` (catches a dirty OR a
// diverged target on a touched file -- more robust than a file-overlap heuristic); on conflict
// it REFUSES and reports, never writing conflict markers. Untracked files are NEVER auto-applied
// (a plain diff misses them, and blindly copying sweeps in residue like a lockfile or drops new
// source): they are listed, and only files named in `includeUntracked` (validated against that
// list) are copied. NEVER removes the worktree (chit_cleanup is the separate step) or touches
// receipts. The CALLER must ensure the run is terminal.
export function applyRunWorkspace(
	git: GitRunner,
	opts: {
		worktreePath: string;
		baseSha: string;
		target: string;
		confirm: boolean;
		includeUntracked?: string[];
	},
): RunApplyResult {
	const lines = (s: string): string[] =>
		s
			.split("\n")
			.map((x) => x.trim())
			.filter(Boolean);

	// The target must be a git work tree: a chit run's diff is applied INTO a repo (it is how the
	// tracked patch is gated, and it bounds where untracked copies land). Refuse otherwise -- never
	// scatter files into an arbitrary directory, even for an untracked-only run (which skips the
	// git patch gate below).
	if (git(["rev-parse", "--is-inside-work-tree"], opts.target).stdout.trim() !== "true") {
		return {
			confirmed: opts.confirm,
			target: opts.target,
			trackedFiles: [],
			appliesClean: false,
			untracked: [],
			untrackedConflicts: [],
			receiptsKept: true,
			note: `target ${JSON.stringify(opts.target)} is not a git work tree; chit_apply only applies into a repo.`,
		};
	}

	// The run's tracked diff vs the base it was cut from.
	const diff = git(["diff", opts.baseSha], opts.worktreePath);
	if (diff.code !== 0) {
		return {
			confirmed: opts.confirm,
			target: opts.target,
			trackedFiles: [],
			appliesClean: false,
			untracked: [],
			untrackedConflicts: [],
			receiptsKept: true,
			note: `could not compute the run's diff from ${opts.baseSha}: ${gitErr(diff)}`,
		};
	}
	const patch = diff.stdout;
	const trackedFiles = lines(git(["diff", "--name-only", opts.baseSha], opts.worktreePath).stdout);
	// Unignored untracked files only (--exclude-standard drops gitignored residue); these are
	// CANDIDATES, surfaced for explicit inclusion -- never auto-applied. The linked node_modules
	// symlink is filtered: it is tooling, never an applicable candidate (see isLinkedToolingPath).
	const untracked = lines(
		git(["ls-files", "--others", "--exclude-standard"], opts.worktreePath).stdout,
	).filter((f) => !isLinkedToolingPath(f));

	// Conflict gate: does the tracked patch apply cleanly to the target? (empty patch is trivially clean)
	const withPatch = <T>(fn: (patchFile: string) => T): T => {
		const dir = mkdtempSync(join(tmpdir(), "chit-apply-"));
		try {
			const patchFile = join(dir, "run.patch");
			writeFileSync(patchFile, patch);
			return fn(patchFile);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	let appliesClean = true;
	let conflict: string | undefined;
	if (patch.trim().length > 0) {
		const check = withPatch((pf) => git(["apply", "--check", "--3way", pf], opts.target));
		appliesClean = check.code === 0;
		if (!appliesClean) conflict = gitErr(check);
	}

	// Untracked-copy PREFLIGHT (ALL checks before ANY mutation, so a copy can never fail mid-apply
	// and leave a partial result): a requested untracked file is a conflict if copying it would
	//   - overwrite an existing target file with DIFFERENT content (identical = harmless no-op), or
	//   - overwrite a directory or a symlink at the dst, or
	//   - have a parent path component that is NOT a plain directory -- a file (mkdir would fail) OR
	//     a symlink (could redirect the copy outside the target; lstat so a dangling symlink still
	//     counts). A name from git ls-files has no `..`, so with every parent a real in-target
	//     directory the dst is provably contained -- no realpath dance needed.
	// Only requested files that are real candidates (in the git untracked list) are considered.
	const requestedUntracked = (opts.includeUntracked ?? []).filter((f) => untracked.includes(f));
	const untrackedConflicts: string[] = [];
	// lstat WITHOUT following symlinks: a dangling/symlink entry must still register as "present".
	const lexists = (p: string): ReturnType<typeof lstatSync> | undefined => {
		try {
			return lstatSync(p);
		} catch {
			return undefined;
		}
	};
	for (const f of requestedUntracked) {
		const dst = join(opts.target, f);
		// every parent component between target and dst must be a real directory (not a file, not a
		// symlink) -- else mkdir fails or the copy escapes, AFTER the tracked patch already applied.
		let parent = dirname(dst);
		let badParent = false;
		while (parent !== opts.target && parent.startsWith(`${opts.target}${sep}`)) {
			const st = lexists(parent);
			if (st && (!st.isDirectory() || st.isSymbolicLink())) {
				badParent = true;
				break;
			}
			parent = dirname(parent);
		}
		if (badParent) {
			untrackedConflicts.push(f);
			continue;
		}
		const st = lexists(dst);
		if (st) {
			// a directory or symlink at dst, or a regular file with different content -> conflict.
			if (st.isDirectory() || st.isSymbolicLink()) {
				untrackedConflicts.push(f);
				continue;
			}
			const same = readFileSync(dst).equals(readFileSync(join(opts.worktreePath, f)));
			if (!same) untrackedConflicts.push(f);
		}
	}

	if (!opts.confirm) {
		const clean = appliesClean && untrackedConflicts.length === 0;
		// What the include_untracked request WOULD copy on confirm. Reported only when the caller
		// actually requested files: it answers "what did my request select" (a typo or an
		// already-tracked name is visibly absent), without adding empty-list noise otherwise.
		// MIRRORS CONFIRM'S ATOMICITY exactly (the invariant: this == confirm's appliedUntracked for
		// the same request/state): ANY conflict -- tracked patch or untracked overwrite -- refuses the
		// whole apply, so a mixed request copies NOTHING; never present the clean subset as "would
		// apply" (drop the conflicting names from include_untracked and re-dry-run instead).
		const requestedCount = (opts.includeUntracked ?? []).length;
		const wouldApplyUntracked = clean ? requestedUntracked : [];
		// The clean note reflects the request: with one, say exactly what would be copied; without
		// one, keep pointing at include_untracked as the way to copy candidates.
		const untrackedClause =
			requestedCount > 0
				? `would copy ${wouldApplyUntracked.length} of ${requestedCount} requested untracked file(s)${untracked.length > wouldApplyUntracked.length ? ` (${untracked.length} candidate(s) total)` : ""}`
				: `${untracked.length} untracked candidate(s) (pass include_untracked to copy specific ones)`;
		return {
			confirmed: false,
			target: opts.target,
			trackedFiles,
			appliesClean,
			...(conflict ? { conflict } : {}),
			untracked,
			untrackedConflicts,
			...(requestedCount > 0 && { wouldApplyUntracked }),
			receiptsKept: true,
			note: clean
				? `dry run: ${trackedFiles.length} tracked file(s) apply cleanly to ${opts.target}; ${untrackedClause}. confirm=true to apply.`
				: !appliesClean
					? `dry run: the tracked patch does NOT apply cleanly to ${opts.target} (it conflicts with the target's current state). Nothing applied.`
					: `dry run: requested untracked file(s) already exist in ${opts.target} with different content (${untrackedConflicts.join(", ")}); applying would overwrite them. Nothing applied.`,
		};
	}

	// confirm: never overwrite silently -- refuse on EITHER a tracked-patch conflict OR an
	// untracked file that would overwrite a different target file. Atomic: apply nothing.
	if (!appliesClean) {
		return {
			confirmed: true,
			target: opts.target,
			trackedFiles,
			appliesClean: false,
			...(conflict ? { conflict } : {}),
			untracked,
			untrackedConflicts,
			applied: false,
			receiptsKept: true,
			note: `refused: the tracked patch conflicts with ${opts.target}; nothing applied. Resolve the target (or apply manually) and retry.`,
		};
	}
	if (untrackedConflicts.length > 0) {
		return {
			confirmed: true,
			target: opts.target,
			trackedFiles,
			appliesClean: true,
			untracked,
			untrackedConflicts,
			applied: false,
			receiptsKept: true,
			note: `refused: requested untracked file(s) already exist in ${opts.target} with different content (${untrackedConflicts.join(", ")}); applying would overwrite them. Nothing applied -- remove/rename them in the target, or drop them from include_untracked, and retry.`,
		};
	}
	if (patch.trim().length > 0) {
		const ap = withPatch((pf) => git(["apply", "--3way", pf], opts.target));
		if (ap.code !== 0) {
			return {
				confirmed: true,
				target: opts.target,
				trackedFiles,
				appliesClean: true,
				applied: false,
				untracked,
				untrackedConflicts,
				receiptsKept: true,
				note: `apply failed after a clean check: ${gitErr(ap)}; nothing partially applied is intended -- inspect ${opts.target}.`,
			};
		}
	}
	// Copy ONLY the explicitly-requested untracked files that are real candidates (never an
	// arbitrary path): the caller opts in per file. Overwrite conflicts were refused above, so a
	// surviving target file here is byte-identical (a harmless idempotent re-copy).
	const appliedUntracked: string[] = [];
	for (const f of requestedUntracked) {
		const dst = join(opts.target, f);
		mkdirSync(dirname(dst), { recursive: true });
		cpSync(join(opts.worktreePath, f), dst);
		appliedUntracked.push(f);
	}
	return {
		confirmed: true,
		target: opts.target,
		trackedFiles,
		appliesClean: true,
		applied: true,
		untracked,
		untrackedConflicts,
		appliedUntracked,
		receiptsKept: true,
		note: `applied ${trackedFiles.length} tracked file(s)${appliedUntracked.length ? ` + ${appliedUntracked.length} untracked` : ""} to ${opts.target}. Receipts kept; the worktree remains for chit_cleanup.`,
	};
}

export interface PartialWork {
	partialWorkPresent: boolean;
	dirtyFiles: string[]; // every uncommitted path (tracked-modified + untracked), from git status
	insertions: number; // tracked line insertions (git diff --numstat; untracked files are not counted)
	deletions: number;
}

// Inspect a run's worktree for UNCOMMITTED work (#100-followup). A run that fails mid-step (e.g.
// the implementer times out before iteration 1 completes) leaves real edits in the worktree that
// NO completed-iteration record captures -- so changedFiles reads empty and the work looks lost.
// This reads the worktree's git state directly so a failed run can surface "partial work is here".
// Read-only; safe on any path (returns empty for a missing/non-git worktree).
export function inspectPartialWork(git: GitRunner, worktreePath: string): PartialWork {
	const empty: PartialWork = {
		partialWorkPresent: false,
		dirtyFiles: [],
		insertions: 0,
		deletions: 0,
	};
	if (!existsSync(worktreePath)) return empty;
	const st = git(["status", "--porcelain"], worktreePath);
	if (st.code !== 0) return empty;
	// porcelain v1: "XY <path>" (or "XY <old> -> <new>" for a rename); the path starts at col 3.
	// The linked node_modules symlink is filtered out: it is tooling, not the run's uncommitted work,
	// so it must not read as partial work (see isLinkedToolingPath).
	const dirtyFiles = st.stdout
		.split("\n")
		.map((l) => l.slice(3).trim())
		.filter(Boolean)
		.filter((f) => !isLinkedToolingPath(f));
	let insertions = 0;
	let deletions = 0;
	// vs HEAD (not the index): an implementer that `git add`ed before timing out has STAGED work --
	// plain `git diff --numstat` (working tree vs index) would miss it and report +0/-0 while the
	// file still shows dirty. `--numstat HEAD` counts staged + unstaged tracked changes vs the base.
	const ns = git(["diff", "--numstat", "HEAD"], worktreePath);
	if (ns.code === 0) {
		for (const line of ns.stdout.split("\n")) {
			const [add, del] = line.split("\t");
			if (add && add !== "-") insertions += Number.parseInt(add, 10) || 0;
			if (del && del !== "-") deletions += Number.parseInt(del, 10) || 0;
		}
	}
	return { partialWorkPresent: dirtyFiles.length > 0, dirtyFiles, insertions, deletions };
}

export interface PartialWorkView {
	worktreePath: string;
	files: string[];
	diffStat: string;
	note: string;
}

// The default converge loop's step ids (mirror converge.ts IMPLEMENT_STEP_ID / REVIEW_STEP_ID,
// kept local to avoid pulling the heavy converge driver into this leaf module). A custom manifest
// can name its steps anything; those fall through to the generic clause, which is never wrong,
// just less specific.
const IMPLEMENT_STEP_ID = "implement";
const REVIEW_STEP_ID = "review";

// Build the partial-work note's failure clause, attributed to the step that ACTUALLY failed.
// The job's failure string is the only structured signal this surface has: the worker wraps a
// step failure as `manifest run failed at step "<step>": <error>` (converge.ts), so the failed
// step and any adapter timeout are both recoverable from it. The old note always blamed the
// implementer, which was wrong when the REVIEW step timed out -- there the implementer had
// finished and its completed work is the uncommitted residue. Exported for direct testing.
export function partialWorkFailureClause(failure?: string): string {
	if (!failure) return "";
	const step = failure.match(/failed at step "([^"]+)"/)?.[1];
	const timeoutMatch = failure.match(/timed out after (\d+)\s*ms/);

	if (timeoutMatch) {
		const elapsed = formatDuration(Number(timeoutMatch[1]));
		if (step === IMPLEMENT_STEP_ID) {
			return ` The implementer timed out after ${elapsed} before committing this work.`;
		}
		if (step === REVIEW_STEP_ID) {
			return ` The implementer's work here is complete but uncommitted; the reviewer timed out after ${elapsed} before the run could converge.`;
		}
		if (step) return ` Step "${step}" timed out after ${elapsed} before the run could converge.`;
		// Timed out but the failure carries no step (raw adapter error): name no actor we cannot
		// confirm, rather than wrongly blaming the implementer.
		return ` A call timed out after ${elapsed} before the run could converge.`;
	}
	// A non-timeout failure: name the step when known, make no timeout/actor claim.
	if (step) return ` The run failed during the "${step}" step.`;
	return "";
}

// Format inspected partial work into the surface both chit_status (single run) and chit_batch_status
// (a task) show, with an honest, actionable note. The failure clause is attributed to the step that
// failed (see partialWorkFailureClause). Returns undefined when there is no partial work to surface.
export function describePartialWork(
	pw: PartialWork,
	worktreePath: string,
	failure?: string,
): PartialWorkView | undefined {
	if (!pw.partialWorkPresent) return undefined;
	const failureClause = partialWorkFailureClause(failure);
	return {
		worktreePath,
		files: pw.dirtyFiles,
		diffStat: `${pw.dirtyFiles.length} file(s), +${pw.insertions} -${pw.deletions}`,
		note: `the run ended without converging, but real uncommitted work is in its worktree.${failureClause} Inspect it with \`git -C ${worktreePath} diff\` (and \`git -C ${worktreePath} status\` for untracked files); it is NOT lost. chit_apply can bring it into a checkout, or chit_cleanup discards it.`,
	};
}
