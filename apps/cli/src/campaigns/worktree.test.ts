import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertClean,
	ensureWorktree,
	type GitResult,
	type GitRunner,
	realGit,
	resolveBaseSha,
	taskWorktree,
	WorktreeError,
} from "./worktree.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "chit-campaign-wt-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// A fake git: returns a canned result per first-arg subcommand, recording calls.
function fakeGit(responses: Record<string, GitResult>): {
	git: GitRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const git: GitRunner = (args) => {
		calls.push(args);
		const key = args[0] ?? "";
		return responses[key] ?? { code: 0, stdout: "", stderr: "" };
	};
	return { git, calls };
}

describe("taskWorktree", () => {
	test("builds the deterministic path and branch", () => {
		const { worktreePath, branch } = taskWorktree("/wt", "chit", "v0-mcp", "issue-9");
		expect(worktreePath).toBe("/wt/chit/campaigns/v0-mcp/issue-9");
		expect(branch).toBe("caiopizzol/campaign-v0-mcp-issue-9");
	});
});

describe("ensureWorktree (faked git)", () => {
	test("cuts a new branch from baseSha when nothing exists", () => {
		const wt = join(root, "wt");
		const { git, calls } = fakeGit({
			// rev-parse --verify --quiet <branch> -> not found
			"rev-parse": { code: 1, stdout: "", stderr: "" },
		});
		const res = ensureWorktree({
			git,
			repo: root,
			worktreePath: wt,
			branch: "b/x",
			baseSha: "deadbeef",
		});
		expect(res.created).toBe(true);
		const add = calls.find((c) => c[0] === "worktree");
		expect(add).toEqual(["worktree", "add", "-b", "b/x", wt, "deadbeef"]);
	});

	test("refuses an existing worktree path without --reuse-worktree", () => {
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const { git } = fakeGit({});
		expect(() =>
			ensureWorktree({ git, repo: root, worktreePath: wt, branch: "b/x", baseSha: "s" }),
		).toThrow(/already exists.*reuse-worktree/);
	});

	test("accepts an existing path with --reuse-worktree and does not add", () => {
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const { git, calls } = fakeGit({});
		const res = ensureWorktree({
			git,
			repo: root,
			worktreePath: wt,
			branch: "b/x",
			baseSha: "s",
			reuseWorktree: true,
		});
		expect(res.created).toBe(false);
		expect(calls.find((c) => c[0] === "worktree")).toBeUndefined();
	});

	test("refuses an existing branch without --reuse-branch", () => {
		const wt = join(root, "wt");
		const { git } = fakeGit({ "rev-parse": { code: 0, stdout: "", stderr: "" } }); // branch exists
		expect(() =>
			ensureWorktree({ git, repo: root, worktreePath: wt, branch: "b/x", baseSha: "s" }),
		).toThrow(/branch already exists.*reuse-branch/);
	});

	test("checks out an existing branch (no -b) with --reuse-branch", () => {
		const wt = join(root, "wt");
		const { git, calls } = fakeGit({ "rev-parse": { code: 0, stdout: "", stderr: "" } });
		ensureWorktree({
			git,
			repo: root,
			worktreePath: wt,
			branch: "b/x",
			baseSha: "s",
			reuseBranch: true,
		});
		expect(calls.find((c) => c[0] === "worktree")).toEqual(["worktree", "add", wt, "b/x"]);
	});

	test("surfaces a git worktree add failure as a WorktreeError", () => {
		const wt = join(root, "wt");
		const { git } = fakeGit({
			"rev-parse": { code: 1, stdout: "", stderr: "" },
			worktree: { code: 128, stdout: "", stderr: "fatal: invalid reference" },
		});
		expect(() =>
			ensureWorktree({ git, repo: root, worktreePath: wt, branch: "b/x", baseSha: "bad" }),
		).toThrow(/git worktree add failed.*invalid reference/);
	});
});

describe("assertClean (faked git)", () => {
	test("passes when porcelain output is empty", () => {
		const { git } = fakeGit({ status: { code: 0, stdout: "\n", stderr: "" } });
		expect(() => assertClean(git, "/wt")).not.toThrow();
	});

	test("throws when the worktree has changes", () => {
		const { git } = fakeGit({ status: { code: 0, stdout: " M file.ts\n", stderr: "" } });
		expect(() => assertClean(git, "/wt")).toThrow(/dirty.*allow-dirty/);
	});
});

// One end-to-end check against real git so the actual invocations are exercised,
// not just the argument shaping.
describe("worktree against real git", () => {
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "chit-campaign-realgit-"));
		const g = (args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
		g(["init", "-q", "-b", "main"]);
		g(["config", "user.email", "t@t.dev"]);
		g(["config", "user.name", "t"]);
		writeFileSync(join(repo, "f.txt"), "hi\n");
		g(["add", "."]);
		g(["commit", "-q", "-m", "init"]);
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("resolves baseSha, creates a clean worktree from it, then detects dirt", () => {
		const sha = resolveBaseSha(realGit, repo, "main");
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		const wt = join(root, "task");
		const res = ensureWorktree({
			git: realGit,
			repo,
			worktreePath: wt,
			branch: "caiopizzol/campaign-c-issue-1",
			baseSha: sha,
		});
		expect(res.created).toBe(true);
		expect(existsSync(join(wt, "f.txt"))).toBe(true);

		// Fresh worktree is clean...
		expect(() => assertClean(realGit, wt)).not.toThrow();
		// ...and a new file makes it dirty.
		writeFileSync(join(wt, "new.txt"), "x\n");
		expect(() => assertClean(realGit, wt)).toThrow(WorktreeError);

		// Clean up the worktree git created.
		execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo });
	});
});
