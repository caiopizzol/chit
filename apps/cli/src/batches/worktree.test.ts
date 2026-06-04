import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyRunWorkspace,
	cleanupRunWorkspace,
	createTaskWorktree,
	type GitResult,
	type GitRunner,
	mainRepoOfWorktree,
	prepareRunWorkspace,
	realGit,
	resolveBaseSha,
	runWorktree,
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

describe("runWorktree layout", () => {
	test("uses <root>/<runId>/<scope-slug> and a chit-run branch", () => {
		const { worktreePath, branch } = runWorktree("run-9", "PII Env Gate", "/wt");
		expect(worktreePath).toBe(join("/wt", "run-9", "pii-env-gate"));
		expect(branch).toBe("chit-run/run-9/pii-env-gate");
	});
	test("defaults the root to ~/worktrees/chit and slugs an empty scope to 'run'", () => {
		const { worktreePath, branch } = runWorktree("r1", "   ");
		expect(worktreePath).toBe(join(homedir(), "worktrees", "chit", "r1", "run"));
		expect(branch).toBe("chit-run/r1/run");
	});
});

describe("prepareRunWorkspace", () => {
	test("in_place runs in the caller checkout: no worktree, no cleanup, touches no git", () => {
		const { git, calls } = scriptedGit([]);
		const ws = prepareRunWorkspace(git, "/repo", { runId: "r", scope: "s", inPlace: true });
		expect(ws.cwd).toBe("/repo");
		expect(ws.worktreePath).toBeUndefined();
		expect(ws.branch).toBeUndefined();
		expect(ws.cleanup).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("isolates a write run in a managed worktree cut off baseSha", () => {
		const root = mkdtempSync(join(tmpdir(), "chit-rw-"));
		try {
			const { git, calls } = scriptedGit([
				{ match: (a) => a.includes("--git-common-dir"), result: ok("/repo/.git\n") }, // mainRepoOfWorktree -> /repo
				{ match: (a) => a.includes("--verify"), result: fail("no such branch") }, // branch absent -> creatable
				{ match: (a) => a[0] === "rev-parse", result: ok("basesha\n") }, // resolveBaseSha(HEAD)
				{ match: (a) => a[0] === "worktree" && a[1] === "add", result: ok() },
			]);
			const ws = prepareRunWorkspace(git, "/repo/sub", {
				runId: "run-1",
				scope: "Owner Readout",
				worktreesRoot: root,
			});
			expect(ws.baseSha).toBe("basesha");
			expect(ws.repo).toBe("/repo"); // the durable main repo (from --git-common-dir), not the caller cwd
			expect(ws.branch).toBe("chit-run/run-1/owner-readout");
			expect(ws.worktreePath).toBe(join(root, "run-1", "owner-readout"));
			expect(ws.cwd).toBe(join(root, "run-1", "owner-readout")); // the run executes IN the worktree
			expect(typeof ws.cleanup).toBe("function");
			expect(
				calls.some((a) => a[0] === "worktree" && a[1] === "add" && a.includes("basesha")),
			).toBe(true); // cut off the resolved baseSha
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("propagates a baseSha resolution failure without creating anything", () => {
		const { git } = scriptedGit([
			{ match: (a) => a.includes("--git-common-dir"), result: ok("/repo/.git\n") },
			{ match: (a) => a[0] === "rev-parse", result: fail("unknown revision") }, // resolveBaseSha(HEAD) fails
		]);
		expect(() =>
			prepareRunWorkspace(git, "/repo", { runId: "r", scope: "s", worktreesRoot: "/wt" }),
		).toThrow(WorktreeError);
	});
});

describe("prepareRunWorkspace isolation (real git): the #85 attribution fix", () => {
	test("the managed worktree is clean off baseSha even when the caller tree is dirty", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-repo-"));
		const root = mkdtempSync(join(tmpdir(), "chit-wt-"));
		try {
			// A real repo with one committed file = baseSha.
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "chit test"], repo);
			writeFileSync(join(repo, "tracked.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			// DIRTY the caller checkout: an uncommitted edit + an untracked file -- the noise
			// that pollutes an in-place run's changedFiles and the reviewer's HEAD diff.
			writeFileSync(join(repo, "tracked.ts"), "DIRTY EDIT\n");
			writeFileSync(join(repo, "untracked.ts"), "noise\n");

			const ws = prepareRunWorkspace(realGit, repo, {
				runId: "run-iso",
				scope: "owner",
				worktreesRoot: root,
			});

			// The worktree is cut clean off baseSha: NONE of the caller's dirt is present.
			expect(realGit(["status", "--porcelain"], ws.cwd).stdout.trim()).toBe("");
			expect(readFileSync(join(ws.cwd, "tracked.ts"), "utf8")).toBe("base\n"); // base, not "DIRTY EDIT"

			// A run editing inside the worktree shows ONLY its own change -- the caller's
			// dirty tracked edit and untracked file never leak in. THIS is the bug #85 fixes:
			// changedFiles (computed from this worktree) is attributable to the run.
			writeFileSync(join(ws.cwd, "tracked.ts"), "run edit\n");
			const changed = realGit(["status", "--porcelain"], ws.cwd).stdout;
			expect(changed).toContain("tracked.ts");
			expect(changed).not.toContain("untracked.ts");
			ws.cleanup?.();
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("cleanupRunWorkspace (#98): single-run worktree retirement", () => {
	test("an in_place run (no worktree) is a no-op, touches no git", () => {
		const { git, calls } = scriptedGit([]);
		const r = cleanupRunWorkspace(git, { repo: "/repo", confirm: true });
		expect(r.removed).toBeUndefined();
		expect(r.receiptsKept).toBe(true);
		expect(r.note).toContain("no chit-managed worktree");
		expect(calls).toEqual([]);
	});

	test("dry run reports the worktree + branch but removes nothing", () => {
		const { git, calls } = scriptedGit([]);
		const r = cleanupRunWorkspace(git, {
			repo: "/repo",
			worktreePath: "/wt/run-1/owner",
			branch: "chit-run/run-1/owner",
			confirm: false,
		});
		expect(r.confirmed).toBe(false);
		expect(r.worktreePath).toBe("/wt/run-1/owner");
		expect(r.branch).toBe("chit-run/run-1/owner");
		expect(r.note).toContain("dry run");
		expect(r.receiptsKept).toBe(true);
		expect(calls).toEqual([]); // nothing removed
	});

	test("confirm removes a run's worktree + empty parent (real git), keeps receipts", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-cleanup-repo-"));
		const root = mkdtempSync(join(tmpdir(), "chit-cleanup-wt-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			const ws = prepareRunWorkspace(realGit, repo, {
				runId: "run-clean",
				scope: "owner",
				worktreesRoot: root,
			});
			// the worktree + its <runId> parent exist
			expect(realGit(["worktree", "list"], repo).stdout).toContain(ws.worktreePath ?? "MISSING");
			// mainRepoOfWorktree resolves the worktree back to the main repo (so cleanup can run
			// `git worktree remove` from there, not from the worktree being removed).
			const wt = ws.worktreePath;
			expect(wt).toBeTruthy();
			// git reports the realpath (macOS /tmp -> /private/tmp); compare realpaths.
			if (wt) expect(mainRepoOfWorktree(realGit, wt)).toBe(realpathSync(repo));

			const r = cleanupRunWorkspace(realGit, {
				repo,
				worktreePath: ws.worktreePath,
				branch: ws.branch,
				confirm: true,
			});
			expect(r.confirmed).toBe(true);
			expect(r.removed).toBe(true);
			expect(r.receiptsKept).toBe(true);
			// worktree dir gone AND the now-empty <runId> parent gone (the #98 wart fix)
			expect(realGit(["worktree", "list"], repo).stdout).not.toContain(`${root}/run-clean`);
			expect(existsSync(join(root, "run-clean", "owner"))).toBe(false);
			expect(existsSync(join(root, "run-clean"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("confirm twice is honestly idempotent: 2nd call is alreadyRemoved, not a phantom removal (0.20.1)", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-idem-repo-"));
		const root = mkdtempSync(join(tmpdir(), "chit-idem-wt-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			const ws = prepareRunWorkspace(realGit, repo, {
				runId: "run-idem",
				scope: "owner",
				worktreesRoot: root,
			});
			const opts = {
				repo: ws.repo ?? repo,
				worktreePath: ws.worktreePath,
				branch: ws.branch,
				confirm: true,
			};
			// First call actually retires the worktree + branch.
			const first = cleanupRunWorkspace(realGit, opts);
			expect(first.removed).toBe(true);
			expect(first.alreadyRemoved).toBeUndefined();
			// Second call: nothing left -> alreadyRemoved, NOT a phantom "removed".
			const second = cleanupRunWorkspace(realGit, opts);
			expect(second.removed).toBe(false);
			expect(second.alreadyRemoved).toBe(true);
			expect(second.receiptsKept).toBe(true);
			expect(second.note).toContain("already removed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("confirm removes the BRANCH even when the worktree dir was already removed (#98 review)", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-cleanup-repo2-"));
		const root = mkdtempSync(join(tmpdir(), "chit-cleanup-wt2-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			const ws = prepareRunWorkspace(realGit, repo, {
				runId: "run-partial",
				scope: "owner",
				worktreesRoot: root,
			});
			const wt = ws.worktreePath;
			const br = ws.branch;
			expect(wt && br).toBeTruthy();
			if (!wt || !br) return;
			// Simulate a PARTIAL state: the worktree DIR is gone (manual removal) but git still
			// tracks the worktree and the chit-run/... branch still exists.
			rmSync(wt, { recursive: true, force: true });
			expect(realGit(["branch", "--list", br], repo).stdout.trim()).toContain(br);

			// cleanup with the STORED repo (ws.repo) must still prune + remove the branch.
			const r = cleanupRunWorkspace(realGit, {
				repo: ws.repo ?? repo,
				worktreePath: wt,
				branch: br,
				confirm: true,
			});
			expect(r.removed).toBe(true);
			expect(realGit(["branch", "--list", br], repo).stdout.trim()).toBe(""); // branch gone
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prepareRunWorkspace records the main repo for cleanup (#98)", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-cleanup-repo3-"));
		const root = mkdtempSync(join(tmpdir(), "chit-cleanup-wt3-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "base\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			const ws = prepareRunWorkspace(realGit, repo, {
				runId: "run-repo",
				scope: "owner",
				worktreesRoot: root,
			});
			expect(ws.repo).toBe(realpathSync(repo)); // the main repo is recorded, not the worktree
			ws.cleanup?.();
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("records the MAIN repo even when the caller is itself a linked worktree (#98 review)", () => {
		const main = mkdtempSync(join(tmpdir(), "chit-main-"));
		const linkedParent = mkdtempSync(join(tmpdir(), "chit-linked-"));
		const root = mkdtempSync(join(tmpdir(), "chit-wt4-"));
		const linked = join(linkedParent, "wt");
		try {
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			// The CALLER runs chit from a LINKED worktree of `main`, not main itself.
			realGit(["worktree", "add", "--detach", "-q", linked], main);

			const ws = prepareRunWorkspace(realGit, linked, {
				runId: "run-linked",
				scope: "owner",
				worktreesRoot: root,
			});
			// repo must be the DURABLE main repo, NOT the linked caller checkout (which could be
			// removed later, breaking cleanup).
			expect(ws.repo).toBe(realpathSync(main));
			expect(ws.repo).not.toBe(realpathSync(linked));
			ws.cleanup?.();
		} finally {
			try {
				realGit(["worktree", "remove", "--force", linked], main);
			} catch {}
			rmSync(main, { recursive: true, force: true });
			rmSync(linkedParent, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("applyRunWorkspace (#101): apply a run's diff back to a checkout", () => {
	// Build a repo + a managed worktree whose "run" changed line 1 of f.ts (tracked) and added a
	// new untracked source file. Returns the pieces + a teardown.
	function applySetup() {
		const main = mkdtempSync(join(tmpdir(), "chit-apply-main-"));
		const root = mkdtempSync(join(tmpdir(), "chit-apply-wt-"));
		realGit(["init", "-q"], main);
		realGit(["config", "user.email", "t@chit.test"], main);
		realGit(["config", "user.name", "t"], main);
		writeFileSync(join(main, "f.ts"), "base line 1\nbase line 2\n");
		realGit(["add", "."], main);
		realGit(["commit", "-qm", "base"], main);
		const ws = prepareRunWorkspace(realGit, main, {
			runId: "run-apply",
			scope: "owner",
			worktreesRoot: root,
		});
		const wt = ws.worktreePath;
		const base = ws.baseSha;
		if (!wt || !base) throw new Error("setup: expected an isolated worktree");
		writeFileSync(join(wt, "f.ts"), "RUN line 1\nbase line 2\n"); // tracked change
		writeFileSync(join(wt, "newfile.ts"), "export const n = 1;\n"); // untracked new source
		return {
			main,
			wt,
			base,
			teardown: () => {
				rmSync(main, { recursive: true, force: true });
				rmSync(root, { recursive: true, force: true });
			},
		};
	}

	test("dry-run reports a clean apply + untracked candidates and changes nothing; confirm applies tracked + explicitly-included untracked", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
			});
			expect(dry.confirmed).toBe(false);
			expect(dry.appliesClean).toBe(true);
			expect(dry.trackedFiles).toContain("f.ts");
			expect(dry.untracked).toContain("newfile.ts");
			expect(existsSync(join(main, "newfile.ts"))).toBe(false); // dry run applied nothing
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("base line 1");

			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: ["newfile.ts"],
			});
			expect(ap.applied).toBe(true);
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("RUN line 1"); // tracked applied
			expect(ap.appliedUntracked).toEqual(["newfile.ts"]);
			expect(existsSync(join(main, "newfile.ts"))).toBe(true); // explicitly included -> copied
		} finally {
			teardown();
		}
	});

	test("untracked files are NOT auto-applied without explicit inclusion (no silent residue / no lost source)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
			});
			expect(ap.applied).toBe(true);
			expect(ap.appliedUntracked).toEqual([]);
			expect(ap.untracked).toContain("newfile.ts"); // listed as a candidate...
			expect(existsSync(join(main, "newfile.ts"))).toBe(false); // ...but not copied
		} finally {
			teardown();
		}
	});

	test("refuses (does not apply) when the target conflicts with the run's change on the same lines", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			// the target dirties f.ts line 1 differently -> overlaps the run's change
			writeFileSync(join(main, "f.ts"), "TARGET DIRTY line 1\nbase line 2\n");
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
			});
			expect(dry.appliesClean).toBe(false);
			expect(dry.conflict).toBeTruthy();

			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
			});
			expect(ap.applied).toBe(false);
			expect(ap.note).toContain("refused");
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("TARGET DIRTY"); // target untouched
		} finally {
			teardown();
		}
	});

	test("applies even when the target is dirty in a DIFFERENT (non-overlapping) file", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			writeFileSync(join(main, "other.ts"), "dirty other\n"); // dirty, but not a file the run touched
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
			});
			expect(ap.applied).toBe(true);
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("RUN line 1");
			expect(readFileSync(join(main, "other.ts"), "utf8")).toBe("dirty other\n"); // the target's own dirt preserved
		} finally {
			teardown();
		}
	});

	test("REFUSES to overwrite an existing target file with an included untracked file of different content (#101 slice 1b)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			// the target already has newfile.ts with DIFFERENT content than the run's
			writeFileSync(join(main, "newfile.ts"), "USER's own newfile, do not clobber\n");
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: ["newfile.ts"],
			});
			// atomic refusal: nothing applied (NOT the tracked patch, NOT the untracked copy)
			expect(ap.applied).toBe(false);
			expect(ap.untrackedConflicts).toEqual(["newfile.ts"]);
			expect(ap.note).toContain("overwrite");
			// the user's file is UNTOUCHED, and the tracked change did NOT apply (atomic)
			expect(readFileSync(join(main, "newfile.ts"), "utf8")).toBe(
				"USER's own newfile, do not clobber\n",
			);
			expect(readFileSync(join(main, "f.ts"), "utf8")).toContain("base line 1"); // tracked NOT applied
		} finally {
			teardown();
		}
	});

	test("an included untracked file IDENTICAL to the target is a harmless no-op, not a conflict (#101 slice 1b)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			// the target already has newfile.ts with the SAME content as the run's
			writeFileSync(join(main, "newfile.ts"), "export const n = 1;\n");
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: ["newfile.ts"],
			});
			expect(ap.applied).toBe(true); // identical content -> not a conflict
			expect(ap.untrackedConflicts).toEqual([]);
			expect(ap.appliedUntracked).toEqual(["newfile.ts"]);
		} finally {
			teardown();
		}
	});

	test("a parent-path collision (target has a FILE where the untracked file needs a dir) refuses ATOMICALLY (#101 review)", () => {
		const main = mkdtempSync(join(tmpdir(), "chit-apply-coll-"));
		const root = mkdtempSync(join(tmpdir(), "chit-apply-collwt-"));
		try {
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			const ws = prepareRunWorkspace(realGit, main, {
				runId: "r-coll",
				scope: "o",
				worktreesRoot: root,
			});
			const wt = ws.worktreePath;
			const base = ws.baseSha;
			if (!wt || !base) return;
			writeFileSync(join(wt, "f.ts"), "RUN\n"); // tracked change
			mkdirSync(join(wt, "dir"));
			writeFileSync(join(wt, "dir", "new.ts"), "x\n"); // untracked under dir/
			// target has `dir` as a FILE -> mkdir dir would fail mid-copy
			writeFileSync(join(main, "dir"), "i am a file\n");

			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: ["dir/new.ts"],
			});
			expect(ap.applied).toBe(false); // refused
			expect(ap.untrackedConflicts).toContain("dir/new.ts");
			// ATOMIC: the tracked patch did NOT apply either, and `dir` (the user's file) is intact
			expect(readFileSync(join(main, "f.ts"), "utf8")).toBe("base\n");
			expect(readFileSync(join(main, "dir"), "utf8")).toBe("i am a file\n");
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses to apply into a target that is not a git work tree (#101 review)", () => {
		const { wt, base, teardown } = applySetup();
		const nonGit = mkdtempSync(join(tmpdir(), "chit-apply-nongit-"));
		try {
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: nonGit,
				confirm: true,
			});
			expect(ap.applied).toBeUndefined(); // never reached the apply
			expect(ap.note).toContain("not a git work tree");
			expect(existsSync(join(nonGit, "f.ts"))).toBe(false); // nothing scattered in
		} finally {
			teardown();
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	test("a DANGLING symlink parent in the target refuses atomically (#101 re-review: lstat, not existsSync)", () => {
		const main = mkdtempSync(join(tmpdir(), "chit-apply-sym-"));
		const root = mkdtempSync(join(tmpdir(), "chit-apply-symwt-"));
		try {
			realGit(["init", "-q"], main);
			realGit(["config", "user.email", "t@chit.test"], main);
			realGit(["config", "user.name", "t"], main);
			writeFileSync(join(main, "f.ts"), "base\n");
			realGit(["add", "."], main);
			realGit(["commit", "-qm", "base"], main);
			const ws = prepareRunWorkspace(realGit, main, {
				runId: "r-sym",
				scope: "o",
				worktreesRoot: root,
			});
			const wt = ws.worktreePath;
			const base = ws.baseSha;
			if (!wt || !base) return;
			writeFileSync(join(wt, "f.ts"), "RUN\n");
			mkdirSync(join(wt, "dir"));
			writeFileSync(join(wt, "dir", "new.ts"), "x\n");
			// target has `dir` as a DANGLING symlink (points outside, target missing). existsSync(dir)
			// is FALSE (follows the dead link); only lstat catches it.
			symlinkSync("/nonexistent/outside/target", join(main, "dir"));

			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: ["dir/new.ts"],
			});
			expect(ap.applied).toBe(false); // refused (symlink parent caught by lstat)
			expect(ap.untrackedConflicts).toContain("dir/new.ts");
			expect(readFileSync(join(main, "f.ts"), "utf8")).toBe("base\n"); // tracked NOT applied (atomic)
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
