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
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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

// Create a worktree + branch off baseSha at an explicit path/branch. Conservative:
// refuses if the branch or the worktree path already exists (never clobbers prior
// work). `git worktree add -b` creates the leaf dir but not missing parents, so the
// parent is created first. The generic core shared by batch tasks and single runs.
export function createWorktree(
	git: GitRunner,
	repo: string,
	worktreePath: string,
	branch: string,
	baseSha: string,
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
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = taskWorktree(batchId, taskId);
	return createWorktree(git, repo, worktreePath, branch, baseSha);
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
	createWorktree(git, repo, worktreePath, branch, baseSha);
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
): { ok: true; removedWorktree: boolean; removedBranch: boolean } | { ok: false; error: string } {
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
	// worktree leaves no litter. rmdir fails (ignored) if siblings remain or it is already gone.
	try {
		rmdirSync(dirname(worktreePath));
	} catch {
		// non-empty (sibling worktrees still present) or already removed -- leave it
	}
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
	// CANDIDATES, surfaced for explicit inclusion -- never auto-applied.
	const untracked = lines(
		git(["ls-files", "--others", "--exclude-standard"], opts.worktreePath).stdout,
	);

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
		return {
			confirmed: false,
			target: opts.target,
			trackedFiles,
			appliesClean,
			...(conflict ? { conflict } : {}),
			untracked,
			untrackedConflicts,
			receiptsKept: true,
			note: clean
				? `dry run: ${trackedFiles.length} tracked file(s) apply cleanly to ${opts.target}; ${untracked.length} untracked candidate(s) (pass include_untracked to copy specific ones). confirm=true to apply.`
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
	const dirtyFiles = st.stdout
		.split("\n")
		.map((l) => l.slice(3).trim())
		.filter(Boolean);
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

// Format inspected partial work into the surface both chit_status (single run) and chit_batch_status
// (a task) show, with an honest, actionable note. Reframes a timeout failure ("...timed out after
// 900000ms") into minutes. Returns undefined when there is no partial work to surface.
export function describePartialWork(
	pw: PartialWork,
	worktreePath: string,
	failure?: string,
): PartialWorkView | undefined {
	if (!pw.partialWorkPresent) return undefined;
	const m = failure?.match(/timed out after (\d+)\s*ms/);
	const timeoutNote = m
		? ` The implementer timed out after ${Math.round(Number(m[1]) / 60_000)}m before committing this work.`
		: "";
	return {
		worktreePath,
		files: pw.dirtyFiles,
		diffStat: `${pw.dirtyFiles.length} file(s), +${pw.insertions} -${pw.deletions}`,
		note: `the run ended without converging, but real uncommitted work is in its worktree.${timeoutNote} Inspect it with \`git -C ${worktreePath} diff\` (and \`git -C ${worktreePath} status\` for untracked files); it is NOT lost. chit_apply can bring it into a checkout, or chit_cleanup discards it.`,
	};
}
