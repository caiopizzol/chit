import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
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
	afterEach(() => {
		for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
	});

	test("isolates edits, shows a diff, and applies back on confirm", async () => {
		const repo = newRepo();
		const sb = await gitWorktreeSandboxFactory.create(repo, "t1");
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
		const sb = await gitWorktreeSandboxFactory.create(repo, "t2");
		writeFileSync(join(sb.workDir, "b.txt"), "scratch\n");
		await sb.discard();
		expect(existsSync(join(repo, "b.txt"))).toBe(false);
		expect(existsSync(sb.workDir)).toBe(false);
	});

	test("refuses a non-git directory with a clear error", async () => {
		const plain = mkdtempSync(join(tmpdir(), "chit-plain-"));
		temps.push(plain);
		await expect(gitWorktreeSandboxFactory.create(plain, "t3")).rejects.toThrow(/needs a git repository/);
	});

	test("reapStaleSandboxes removes a leftover sandbox worktree (interrupted run)", async () => {
		const repo = newRepo();
		const sb = await gitWorktreeSandboxFactory.create(repo, "leak");
		// simulate a force-killed run: the worktree exists, discard never ran
		expect(existsSync(sb.workDir)).toBe(true);
		const removed = await reapStaleSandboxes(repo);
		expect(removed.length).toBeGreaterThanOrEqual(1);
		expect(existsSync(sb.workDir)).toBe(false);
	});
});
