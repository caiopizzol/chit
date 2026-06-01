// Git worktree management for campaign tasks. Conservative by design (see
// notes/campaign-v0.md): deterministic path + branch, created from the
// campaign's recorded baseSha, refusing to clobber an existing path or branch
// unless explicitly allowed, and never removed automatically.
//
// All git access goes through an injected GitRunner so the logic is unit-tested
// without a real repo. The default runner shells out to `git`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export class WorktreeError extends Error {}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitResult;

// Default runner: run `git` in cwd, capturing output. Never throws; a non-zero
// exit is returned as a GitResult so callers decide what is fatal.
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

// ~/worktrees, the root the campaign creates task checkouts under.
export function worktreeRoot(): string {
	return join(homedir(), "worktrees");
}

// Deterministic checkout path and branch for a task. `root` is the worktree
// root (worktreeRoot() in production; a temp dir in tests).
export function taskWorktree(
	root: string,
	repoName: string,
	campaignId: string,
	taskId: string,
): { worktreePath: string; branch: string } {
	return {
		worktreePath: join(root, repoName, "campaigns", campaignId, taskId),
		branch: `caiopizzol/campaign-${campaignId}-${taskId}`,
	};
}

// repoName for the deterministic path: the main checkout's directory name.
export function repoName(repo: string): string {
	return basename(repo);
}

// Resolve a ref (branch name) to a concrete commit sha in the repo.
export function resolveBaseSha(git: GitRunner, repo: string, ref: string): string {
	const r = git(["rev-parse", ref], repo);
	if (r.code !== 0) {
		throw new WorktreeError(`cannot resolve base ref ${JSON.stringify(ref)}: ${gitErr(r)}`);
	}
	return r.stdout.trim();
}

function branchExists(git: GitRunner, repo: string, branch: string): boolean {
	return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).code === 0;
}

export interface EnsureWorktreeOptions {
	git: GitRunner;
	repo: string; // main checkout (where git worktree add runs)
	worktreePath: string;
	branch: string;
	baseSha: string;
	reuseWorktree?: boolean;
	reuseBranch?: boolean;
}

// Create the task worktree if it does not exist. Returns whether it was created.
// Refuses an existing path (unless reuseWorktree) or branch (unless reuseBranch).
export function ensureWorktree(opts: EnsureWorktreeOptions): { created: boolean } {
	const { git, repo, worktreePath, branch, baseSha } = opts;

	if (existsSync(worktreePath)) {
		if (!opts.reuseWorktree) {
			throw new WorktreeError(
				`worktree path already exists: ${worktreePath} (pass --reuse-worktree to use it)`,
			);
		}
		return { created: false };
	}

	const exists = branchExists(git, repo, branch);
	if (exists && !opts.reuseBranch) {
		throw new WorktreeError(
			`branch already exists: ${branch} (pass --reuse-branch to check it out)`,
		);
	}

	// git worktree add creates the leaf dir, but not missing intermediate dirs.
	mkdirSync(dirname(worktreePath), { recursive: true });

	// Reuse an existing branch by checking it out; otherwise cut a new branch from
	// the recorded baseSha so the task starts from a known, pinned commit.
	const args = exists
		? ["worktree", "add", worktreePath, branch]
		: ["worktree", "add", "-b", branch, worktreePath, baseSha];
	const r = git(args, repo);
	if (r.code !== 0) {
		throw new WorktreeError(`git worktree add failed: ${gitErr(r)}`);
	}
	return { created: true };
}

// Throw unless the worktree has a clean working tree (no staged, unstaged, or
// untracked changes). The clean precondition for running a task.
export function assertClean(git: GitRunner, worktreePath: string): void {
	const r = git(["status", "--porcelain"], worktreePath);
	if (r.code !== 0) {
		throw new WorktreeError(`cannot read git status in ${worktreePath}: ${gitErr(r)}`);
	}
	if (r.stdout.trim() !== "") {
		throw new WorktreeError(
			`worktree is dirty: ${worktreePath} (commit/stash changes or pass --allow-dirty)`,
		);
	}
}

// Human-readable cleanup, printed by status; the campaign never runs these.
export function cleanupInstructions(repo: string, worktreePath: string, branch: string): string {
	return `git -C ${repo} worktree remove ${worktreePath} && git -C ${repo} branch -D ${branch}`;
}

function gitErr(r: GitResult): string {
	return (r.stderr.trim() || r.stdout.trim() || `git exited ${r.code}`).split("\n")[0] ?? "";
}
