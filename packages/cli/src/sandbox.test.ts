import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSandbox, gitWorktreeSandboxFactory, reapStaleSandboxes } from "./sandbox.ts";

describe("fakeSandbox", () => {
	test("records apply/discard and returns the canned diff", async () => {
		const sb = fakeSandbox({ workDir: "/wt", diff: "diff body" });
		expect(sb.workDir).toBe("/wt");
		expect(await sb.diff()).toBe("diff body");
		expect(await sb.status()).toEqual(["M\tfile"]);
		await sb.apply();
		expect(sb.applied).toBe(true);
		expect(sb.discarded).toBe(false);
	});
});

describe("gitWorktreeSandbox (real git)", () => {
	const temps: string[] = [];
	function newRepo(): string {
		const repo = mkdtempSync(join(tmpdir(), "chit-origin-"));
		temps.push(repo);
		const sh = (cmd: string) => {
			const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: repo });
			if (r.exitCode !== 0) throw new Error(`${cmd}: ${new TextDecoder().decode(r.stderr)}`);
		};
		sh("git init -q");
		sh("git config user.email t@t.co && git config user.name tester");
		writeFileSync(join(repo, "a.txt"), "hello\n");
		sh("git add -A && git commit -q -m init");
		return repo;
	}
	async function createSandbox(repo: string, runId: string) {
		const { baseCommit } = await gitWorktreeSandboxFactory.preflight(repo);
		return gitWorktreeSandboxFactory.create(repo, runId, baseCommit);
	}
	afterEach(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});

	test("isolates edits, shows a diff, and applies back on confirm", async () => {
		const repo = newRepo();
		const sb = await createSandbox(repo, "t1");
		expect(sb.workDir).not.toBe(repo);

		// builder edits inside the sandbox: a new file and a change to an existing one
		writeFileSync(join(sb.workDir, "b.txt"), "new file\n");
		writeFileSync(join(sb.workDir, "a.txt"), "hello\nedited\n");
		// origin is untouched so far
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("hello\n");

		const diff = await sb.diff();
		expect(diff).toContain("b.txt");
		expect(diff).toContain("edited");
		expect((await sb.status()).join("\n")).toContain("b.txt");

		await sb.apply();
		expect(readFileSync(join(repo, "b.txt"), "utf-8")).toBe("new file\n");
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("hello\nedited\n");

		await sb.discard();
		expect(existsSync(sb.workDir)).toBe(false);
	});

	test("discard leaves the origin untouched", async () => {
		const repo = newRepo();
		const sb = await createSandbox(repo, "t2");
		writeFileSync(join(sb.workDir, "b.txt"), "scratch\n");
		await sb.discard();
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
		expect(existsSync(sb.workDir)).toBe(false);
	});

	test("refuses a non-git directory with a clear error", async () => {
		const plain = mkdtempSync(join(tmpdir(), "chit-plain-"));
		temps.push(plain);
		await expect(gitWorktreeSandboxFactory.create(plain, "t3", "HEAD")).rejects.toThrow(/needs a git repository/);
	});

	test("creates the worktree from the accepted base commit, not floating HEAD", async () => {
		const repo = newRepo();
		const { baseCommit } = await gitWorktreeSandboxFactory.preflight(repo);
		const sh = (cmd: string) => {
			const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: repo });
			if (r.exitCode !== 0) throw new Error(`${cmd}: ${new TextDecoder().decode(r.stderr)}`);
		};
		writeFileSync(join(repo, "a.txt"), "moved head\n");
		sh("git add -A && git commit -q -m move-head");

		const sb = await gitWorktreeSandboxFactory.create(repo, "pinned", baseCommit);
		expect(readFileSync(join(sb.workDir, "a.txt"), "utf-8")).toBe("hello\n");
		await sb.discard();
	});

	test("reapStaleSandboxes removes a leftover sandbox whose owner is gone (interrupted run)", async () => {
		const repo = newRepo();
		const sb = await createSandbox(repo, "leak");
		// simulate a force-killed run: the worktree exists, discard never ran, and the
		// owning process has exited -- rewrite the lock to a pid that is no longer alive
		const ghost = Bun.spawn(["sh", "-c", "exit 0"]);
		const deadPid = ghost.pid;
		await ghost.exited;
		writeFileSync(join(dirname(sb.workDir), "owner.pid"), String(deadPid));
		expect(existsSync(sb.workDir)).toBe(true);

		const removed = await reapStaleSandboxes(repo);
		expect(removed.length).toBeGreaterThanOrEqual(1);
		expect(existsSync(sb.workDir)).toBe(false);
	});

	test("reapStaleSandboxes leaves an ACTIVE sandbox (live owner) untouched", async () => {
		const repo = newRepo();
		// create() stamps THIS process's pid as the owner, and this process is alive,
		// so a concurrent `chit cleanup` must not pull the sandbox out from under it.
		const sb = await createSandbox(repo, "active");
		const removed = await reapStaleSandboxes(repo);
		expect(removed).toEqual([]);
		expect(existsSync(sb.workDir)).toBe(true);
		await sb.discard(); // we own it; clean it up ourselves
	});
});
