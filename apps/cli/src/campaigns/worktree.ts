// Git worktree management for campaign tasks: one isolated worktree + branch per
// task, created off the campaign's resolved base SHA so every task starts from
// the same point. Conservative by design and with an injectable GitRunner so the
// engine is testable without touching real git. Salvaged from the campaign-v0
// prototype; the worktree path is the agreed v1 layout.
//
// Worktrees are NEVER auto-removed: they ARE the review artifacts a human
// inspects after the campaign. Cleanup is a separate, explicit step.

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
//   ~/worktrees/chit/<campaignId>/<taskId>   (absolute, recorded in state)
//   branch: chit-campaign/<campaignId>/<taskId>
export function taskWorktree(
	campaignId: string,
	taskId: string,
): { worktreePath: string; branch: string } {
	return {
		worktreePath: join(homedir(), "worktrees", "chit", campaignId, taskId),
		branch: `chit-campaign/${campaignId}/${taskId}`,
	};
}

// Resolve a ref (branch/SHA) to a concrete commit SHA in the repo, so every task
// branches from one fixed base even if the repo's HEAD moves mid-campaign.
export function resolveBaseSha(git: GitRunner, repo: string, ref: string): string {
	const r = git(["rev-parse", ref], repo);
	if (r.code !== 0) {
		throw new WorktreeError(`cannot resolve base ref ${JSON.stringify(ref)}: ${gitErr(r)}`);
	}
	return r.stdout.trim();
}

// The repo's top-level path, so a campaign started from a subdir still creates
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
	campaignId: string,
	taskId: string,
	baseSha: string,
): { worktreePath: string; branch: string } {
	const { worktreePath, branch } = taskWorktree(campaignId, taskId);

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
