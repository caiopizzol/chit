// Where chit stores convergence loop logs. Loop logs USED to live in the
// reviewed repo at <cwd>/.chit/loops/, which contaminated the converge reviewer's
// git diff and the reported changedFiles with chit's own bookkeeping. They now
// live under the state dir (like the audit store), namespaced by a stable repo
// key so human-chosen loop ids (p1, smoke, docs) cannot collide across repos.
//
// repoKey = sha256(realpath(git top-level)) when cwd is inside a git work tree,
// else sha256(realpath(cwd)). Keying by the TOP-LEVEL (not the invocation
// subdirectory) means a run from any subdir of a repo shares one namespace; two
// git worktrees with different top-level paths are distinct, so parallel task
// worktrees never fight over a loop id.
//
// This module is the single resolver. The CLI (the writer) owns it; the Studio
// server is READ-only over loop logs and is given the resolved directory at
// startup (it never reimplements the scheme), the same way it is handed the
// audit dir.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function gitTopLevel(cwd: string): string | undefined {
	try {
		const out = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			// Never leak git's stderr (e.g. "not a git repository") to the caller.
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (out.status !== 0) return undefined;
		const top = out.stdout.trim();
		return top || undefined;
	} catch {
		return undefined;
	}
}

// The repo root a loop belongs to: the git top-level (canonicalized) when cwd is
// inside a work tree, else the canonical cwd. realpath so a symlinked path keys
// the same as its real path; an unresolvable path falls back to the raw string.
export function repoRoot(cwd: string): string {
	const base = gitTopLevel(cwd) ?? cwd;
	try {
		return realpathSync(base);
	} catch {
		return base;
	}
}

// Stable, filesystem-safe key for a repo root: the first 16 hex of its sha256.
// Short enough for a tidy dir name, wide enough that collisions are not a
// practical concern for a local per-user state dir.
export function repoKey(cwd: string): string {
	return createHash("sha256").update(repoRoot(cwd)).digest("hex").slice(0, 16);
}

// Base state dir for loop logs: $XDG_STATE_HOME/chit/loops or
// ~/.local/state/chit/loops. Mirrors the audit store's defaultAuditDir.
export function loopStateDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "loops");
}

// The directory holding this repo's loop logs under the state dir.
export function loopLogDir(cwd: string): string {
	return join(loopStateDir(), repoKey(cwd));
}
