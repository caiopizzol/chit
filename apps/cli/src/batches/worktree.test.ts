import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createTaskWorktree,
	type GitResult,
	type GitRunner,
	resolveBaseSha,
	taskWorktree,
	WorktreeError,
} from "./worktree.ts";

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): GitResult => ({ code: 1, stdout: "", stderr });

// A scripted GitRunner: maps a matcher on the args to a result, in order.
function scriptedGit(handlers: Array<{ match: (args: string[]) => boolean; result: GitResult }>): {
	git: GitRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const git: GitRunner = (args) => {
		calls.push(args);
		const h = handlers.find((x) => x.match(args));
		return h ? h.result : ok();
	};
	return { git, calls };
}

describe("taskWorktree layout", () => {
	test("uses ~/worktrees/chit/<batchId>/<taskId> and a namespaced branch", () => {
		const { worktreePath, branch } = taskWorktree("camp1", "task-a");
		expect(worktreePath).toBe(join(homedir(), "worktrees", "chit", "camp1", "task-a"));
		expect(branch).toBe("chit-batch/camp1/task-a");
	});
});

describe("resolveBaseSha", () => {
	test("returns the trimmed sha", () => {
		const { git } = scriptedGit([{ match: (a) => a[0] === "rev-parse", result: ok("deadbeef\n") }]);
		expect(resolveBaseSha(git, "/repo", "main")).toBe("deadbeef");
	});
	test("throws WorktreeError on an unknown ref", () => {
		const { git } = scriptedGit([
			{ match: (a) => a[0] === "rev-parse", result: fail("unknown revision") },
		]);
		expect(() => resolveBaseSha(git, "/repo", "nope")).toThrow(WorktreeError);
	});
});

describe("createTaskWorktree", () => {
	test("refuses when the branch already exists (never clobbers)", () => {
		// rev-parse --verify on the branch returns 0 (exists)
		const { git } = scriptedGit([{ match: (a) => a.includes("--verify"), result: ok("sha") }]);
		expect(() => createTaskWorktree(git, "/repo", "c", "t", "base")).toThrow(/already exists/);
	});

	test("surfaces a git worktree add failure as WorktreeError", () => {
		// branch does not exist (verify fails), worktree path is a fresh tmp dir,
		// the add itself fails.
		const fresh = join("/tmp", `chit-wt-${Math.abs(Date.now() % 1000000)}-does-not-exist`);
		const { git } = scriptedGit([
			{ match: (a) => a.includes("--verify"), result: fail("not a valid ref") },
			{
				match: (a) => a[0] === "worktree" && a[1] === "add",
				result: fail("fatal: invalid reference"),
			},
		]);
		// taskWorktree returns a ~/worktrees path; to avoid depending on the real
		// home dir state we only assert the error mapping, which fires before any fs
		// effect would matter here because the add is stubbed to fail.
		void fresh;
		expect(() => createTaskWorktree(git, "/repo", "c-uniq-xyz", "t-uniq-xyz", "base")).toThrow(
			/git worktree add failed.*invalid reference/,
		);
	});
});
