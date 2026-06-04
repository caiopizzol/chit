// Git worktree management for batch tasks: one isolated worktree + branch per
// task, created off the batch's resolved base SHA so every task starts from
// the same point. Conservative by design and with an injectable GitRunner so the
// engine is testable without touching real git. Salvaged from the batch-v0
// prototype; the worktree path is the agreed v1 layout.
//
// Worktrees are NEVER auto-removed: they ARE the review artifacts a human
// inspects after the batch. Cleanup is a separate, explicit step.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
): { cwd: string; worktreePath?: string; branch?: string; baseSha?: string; cleanup?: () => void } {
	if (opts.inPlace) return { cwd: callerCwd };
	const repo = repoToplevel(git, callerCwd);
	const baseSha = resolveBaseSha(git, repo, opts.baseRef ?? "HEAD");
	const { worktreePath, branch } = runWorktree(opts.runId, opts.scope, opts.worktreesRoot);
	createWorktree(git, repo, worktreePath, branch, baseSha);
	return {
		cwd: worktreePath,
		worktreePath,
		branch,
		baseSha,
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
): { ok: true } | { ok: false; error: string } {
	if (existsSync(worktreePath)) {
		const r = git(["worktree", "remove", "--force", worktreePath], repo);
		if (r.code !== 0) return { ok: false, error: `git worktree remove failed: ${gitErr(r)}` };
	} else {
		// The worktree dir is gone but git may still track it; prune stale entries.
		git(["worktree", "prune"], repo);
	}
	if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).code === 0) {
		const b = git(["branch", "-D", branch], repo);
		if (b.code !== 0) return { ok: false, error: `git branch -D failed: ${gitErr(b)}` };
	}
	// Best-effort: drop the now-empty <id> parent (chit/<batchId> or chit/<runId>) so a removed
	// worktree leaves no litter. rmdir fails (ignored) if siblings remain or it is already gone.
	try {
		rmdirSync(dirname(worktreePath));
	} catch {
		// non-empty (sibling worktrees still present) or already removed -- leave it
	}
	return { ok: true };
}

export interface RunCleanupResult {
	confirmed: boolean; // false = dry run (nothing removed)
	worktreePath?: string;
	branch?: string;
	removed?: boolean; // set on confirm: did the worktree/branch get retired
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
	return {
		confirmed: true,
		worktreePath: opts.worktreePath,
		branch: opts.branch,
		removed: r.ok,
		...(r.ok ? {} : { error: r.error }),
		receiptsKept: true,
		note: r.ok
			? "removed the worktree + branch. Receipts (loop log / audit) are kept."
			: `failed to remove the worktree: ${r.error}`,
	};
}
