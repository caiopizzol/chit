import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
	createPlanStepWorktree,
	createTaskWorktree,
	describePartialWork,
	type GitResult,
	type GitRunner,
	inspectPartialWork,
	mainRepoOfWorktree,
	partialWorkFailureClause,
	planIntegrationWorktree,
	planStepWorktree,
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

describe("plan worktree layout", () => {
	test("integration sits at ~/worktrees/chit/<planId>/integration with a namespaced branch", () => {
		const { worktreePath, branch } = planIntegrationWorktree("p1");
		expect(worktreePath).toBe(join(homedir(), "worktrees", "chit", "p1", "integration"));
		expect(branch).toBe("chit-plan/p1/integration");
	});
	test("a step sits under steps/ so a step id of 'integration' cannot collide", () => {
		const step = planStepWorktree("p1", "schema");
		expect(step.worktreePath).toBe(join(homedir(), "worktrees", "chit", "p1", "steps", "schema"));
		expect(step.branch).toBe("chit-plan/p1/steps/schema");
		// The pathological step id is disjoint from the integration worktree/branch.
		const collide = planStepWorktree("p1", "integration");
		expect(collide.worktreePath).not.toBe(planIntegrationWorktree("p1").worktreePath);
		expect(collide.branch).not.toBe(planIntegrationWorktree("p1").branch);
	});
});

describe("createPlanStepWorktree", () => {
	// The plan layout is rooted at homedir(); point HOME at a temp dir so createWorktree's
	// mkdirSync(dirname) writes there (and is cleaned up) instead of littering the real home.
	let home: string;
	let savedHome: string | undefined;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "chit-plan-home-"));
		savedHome = process.env.HOME;
		process.env.HOME = home;
	});
	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("refuses when the branch already exists (never clobbers)", () => {
		const { git } = scriptedGit([{ match: (a) => a.includes("--verify"), result: ok("sha") }]);
		expect(() => createPlanStepWorktree(git, "/repo", "p", "s", "base")).toThrow(/already exists/);
	});
	test("surfaces a git worktree add failure as WorktreeError", () => {
		const { git } = scriptedGit([
			{ match: (a) => a.includes("--verify"), result: fail("not a valid ref") },
			{ match: (a) => a[0] === "worktree" && a[1] === "add", result: fail("fatal: bad ref") },
		]);
		expect(() => createPlanStepWorktree(git, "/repo", "p", "s", "base")).toThrow(
			/git worktree add failed.*bad ref/,
		);
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
			// callerCheckout must be the LINKED launching checkout (#103: chit_apply's default
			// target), distinct from the durable main repo.
			expect(ws.callerCheckout).toBe(realpathSync(linked));
			expect(ws.callerCheckout).not.toBe(ws.repo);
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
			// #103 disclosure premise: git apply --3way STAGES the tracked change (it shows under
			// --cached, NOT git diff), while the copied untracked file is UNSTAGED.
			expect(realGit(["diff", "--cached", "--name-only"], main).stdout).toContain("f.ts");
			expect(realGit(["diff", "--name-only"], main).stdout).not.toContain("f.ts");
			const unstaged = realGit(["status", "--porcelain", "newfile.ts"], main).stdout;
			expect(unstaged.startsWith("??")).toBe(true); // untracked copy -> unstaged
		} finally {
			teardown();
		}
	});

	test("dry-run with include_untracked reports wouldApplyUntracked (and still applies nothing)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
				includeUntracked: ["newfile.ts"],
			});
			expect(dry.confirmed).toBe(false);
			expect(dry.wouldApplyUntracked).toEqual(["newfile.ts"]); // what confirm WOULD copy
			expect(dry.note).toContain("would copy 1 of 1 requested untracked file(s)");
			expect(existsSync(join(main, "newfile.ts"))).toBe(false); // dry run still applies nothing
		} finally {
			teardown();
		}
	});

	test("dry-run surfaces a request that selects NOTHING (typo / tracked name silently matched nothing before)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			// "typo.ts" is not a candidate; "f.ts" is tracked (also not an untracked candidate).
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
				includeUntracked: ["typo.ts", "f.ts"],
			});
			expect(dry.wouldApplyUntracked).toEqual([]); // the request selected nothing -- visible now
			expect(dry.note).toContain("would copy 0 of 2 requested untracked file(s)");
			expect(dry.untracked).toContain("newfile.ts"); // the real candidate is still listed
		} finally {
			teardown();
		}
	});

	test("dry-run WITHOUT include_untracked keeps its prior shape (no wouldApplyUntracked, same hint)", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
			});
			expect("wouldApplyUntracked" in dry).toBe(false); // no empty-list noise when nothing was requested
			expect(dry.note).toContain("pass include_untracked to copy specific ones");
		} finally {
			teardown();
		}
	});

	test("a mixed request (one clean, one conflicting) would apply NOTHING -- dry-run mirrors confirm's atomicity", () => {
		const { main, wt, base, teardown } = applySetup();
		try {
			// A second untracked file in the worktree that ALREADY exists in the target with
			// different content -> a conflict. Confirm is ALL-OR-NOTHING: it refuses the whole
			// apply, so the dry run must NOT claim the clean newfile.ts "would apply" (independent
			// review caught exactly that mismatch).
			writeFileSync(join(wt, "clash.ts"), "run version\n");
			writeFileSync(join(main, "clash.ts"), "target version\n");
			const request = ["newfile.ts", "clash.ts"];
			const dry = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: false,
				includeUntracked: request,
			});
			expect(dry.untrackedConflicts).toEqual(["clash.ts"]);
			expect(dry.wouldApplyUntracked).toEqual([]); // this exact request copies nothing
			// The invariant: confirm with the SAME request behaves exactly as the dry run said.
			const ap = applyRunWorkspace(realGit, {
				worktreePath: wt,
				baseSha: base,
				target: main,
				confirm: true,
				includeUntracked: request,
			});
			expect(ap.applied).toBe(false); // atomic refusal
			expect(ap.appliedUntracked).toBeUndefined();
			expect(existsSync(join(main, "newfile.ts"))).toBe(false); // the clean file was NOT copied either
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

describe("inspectPartialWork + describePartialWork (partial-work visibility)", () => {
	test("inspectPartialWork reports uncommitted tracked + untracked work; clean/missing -> none", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-pw-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "a\nb\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			expect(inspectPartialWork(realGit, repo).partialWorkPresent).toBe(false); // clean
			expect(inspectPartialWork(realGit, join(repo, "nope")).partialWorkPresent).toBe(false); // missing
			// dirty: edit a tracked file + add an untracked one
			writeFileSync(join(repo, "f.ts"), "A\nb\nc\n");
			writeFileSync(join(repo, "new.ts"), "x\n");
			const pw = inspectPartialWork(realGit, repo);
			expect(pw.partialWorkPresent).toBe(true);
			expect(pw.dirtyFiles).toContain("f.ts");
			expect(pw.dirtyFiles).toContain("new.ts"); // untracked counts as dirty
			expect(pw.insertions).toBeGreaterThan(0); // tracked insertions counted
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("STAGED partial work (the implementer git add'd before timing out) is counted, not +0/-0 (#review)", () => {
		const repo = mkdtempSync(join(tmpdir(), "chit-pw-staged-"));
		try {
			realGit(["init", "-q"], repo);
			realGit(["config", "user.email", "t@chit.test"], repo);
			realGit(["config", "user.name", "t"], repo);
			writeFileSync(join(repo, "f.ts"), "a\nb\n");
			realGit(["add", "."], repo);
			realGit(["commit", "-qm", "base"], repo);
			// edit AND stage it (implementer committed work to the index, then the step died)
			writeFileSync(join(repo, "f.ts"), "a\nb\nc\nd\n");
			realGit(["add", "f.ts"], repo);
			const pw = inspectPartialWork(realGit, repo);
			expect(pw.partialWorkPresent).toBe(true);
			expect(pw.dirtyFiles).toContain("f.ts");
			expect(pw.insertions).toBe(2); // counted vs HEAD even though staged (plain git diff would be 0)
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("describePartialWork: none -> undefined; present -> view with files/diffstat/inspect hint", () => {
		expect(
			describePartialWork(
				{ partialWorkPresent: false, dirtyFiles: [], insertions: 0, deletions: 0 },
				"/wt",
			),
		).toBeUndefined();
		const pw = {
			partialWorkPresent: true,
			dirtyFiles: ["a.ts", "b.ts"],
			insertions: 110,
			deletions: 24,
		};
		const v = describePartialWork(pw, "/wt/run/scope", 'manifest run failed at step "review": x');
		expect(v?.files).toEqual(["a.ts", "b.ts"]);
		expect(v?.diffStat).toBe("2 file(s), +110 -24");
		expect(v?.note).toContain("uncommitted work");
		expect(v?.note).toContain("git -C /wt/run/scope diff");
	});

	// The actor-attribution bug: the old note always blamed the implementer, even when the
	// REVIEW step timed out (the implementer had finished; its work is the residue). The clause
	// is now derived from the failed step in the failure string.
	describe("partialWorkFailureClause: attributes the timeout to the step that failed", () => {
		const reviewTimeout =
			'manifest run failed at step "review": codex exec timed out after 600000ms';
		const implementTimeout =
			'manifest run failed at step "implement": claude --print timed out after 2000ms';

		test("a REVIEW-step timeout blames the reviewer, NOT the implementer", () => {
			const clause = partialWorkFailureClause(reviewTimeout);
			expect(clause).toContain("reviewer timed out after 10m");
			expect(clause).toContain("complete but uncommitted");
			expect(clause).not.toContain("The implementer timed out"); // the actual bug
		});

		test("an IMPLEMENT-step timeout still names the implementer", () => {
			const clause = partialWorkFailureClause(implementTimeout);
			expect(clause).toContain("The implementer timed out after 2s"); // 2000ms -> 2s
			expect(clause).not.toContain("reviewer");
		});

		test("a non-default step timeout names the step generically (no actor guess)", () => {
			const clause = partialWorkFailureClause(
				'manifest run failed at step "build": claude --print timed out after 300000ms',
			);
			expect(clause).toContain('Step "build" timed out after 5m');
			expect(clause).not.toContain("implementer");
			expect(clause).not.toContain("reviewer");
		});

		test("a timeout with no step (raw adapter error) names no unconfirmed actor", () => {
			const clause = partialWorkFailureClause("claude --print timed out after 900000ms");
			expect(clause).toContain("A call timed out after 15m");
			expect(clause).not.toContain("implementer");
		});

		test("a non-timeout step failure names the step, claims no timeout", () => {
			const clause = partialWorkFailureClause('manifest run failed at step "review": boom');
			expect(clause).toContain('failed during the "review" step');
			expect(clause).not.toContain("timed out");
		});

		test("no failure / unparseable failure -> empty clause (base note only)", () => {
			expect(partialWorkFailureClause(undefined)).toBe("");
			expect(partialWorkFailureClause("some other error")).toBe("");
		});
	});
});
