// Git worktree management for batch tasks: one isolated worktree + branch per
// task, created off the batch's resolved base SHA so every task starts from
// the same point. Conservative by design and with an injectable GitRunner so the
// engine is testable without touching real git. Salvaged from the batch-v0
// prototype; the worktree path is the agreed v1 layout.
//
// Worktrees are NEVER auto-removed: they ARE the review artifacts a human
// inspects after the batch. Cleanup is a separate, explicit step.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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

// Create the task's worktree + branch off baseSha. Conservative: refuses if the
// branch or the worktree path already exists (never clobbers prior work).
// `git worktree add -b` creates the leaf dir but not missing parents, so the
// parent is created first. Returns the absolute worktree path + branch.
export function createTaskWorktree(
	git: GitRunner,
	repo: string,
	batchId: string,
	taskId: string,
	baseSha: string,
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = taskWorktree(batchId, taskId);

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
	return { ok: true };
}
