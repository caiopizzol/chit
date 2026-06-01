import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopRecord } from "@chit/core";
import { campaignExists, readCampaign } from "../campaigns/store.ts";
import type { GitRunner } from "../campaigns/worktree.ts";
import {
	type CampaignDeps,
	type CampaignIO,
	outcomeFromLoop,
	runCampaign,
	type TaskRunOutcome,
	type TaskRunParams,
} from "./campaign.ts";

let repo: string;
let wtRoot: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "chit-campaign-repo-"));
	wtRoot = mkdtempSync(join(tmpdir(), "chit-campaign-wtroot-"));
});
afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(wtRoot, { recursive: true, force: true });
});

// Capturing IO.
function makeIO(): { io: CampaignIO; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

// A fake git tuned for the campaign code paths: --show-toplevel returns the repo,
// branch-existence checks miss, base ref resolves to a fixed sha, worktree/status
// succeed (clean). Records all calls.
function makeGit(over: { branchExists?: boolean; dirty?: boolean } = {}): {
	git: GitRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const git: GitRunner = (args) => {
		calls.push(args);
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return { code: 0, stdout: `${repo}\n`, stderr: "" };
		}
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			return { code: over.branchExists ? 0 : 1, stdout: "", stderr: "" };
		}
		if (args[0] === "rev-parse") return { code: 0, stdout: "deadbeefcafef00d\n", stderr: "" };
		if (args[0] === "status") {
			return { code: 0, stdout: over.dirty ? " M f.ts\n" : "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { git, calls };
}

// Fake issues by number.
function fakeFetch(
	issues: Record<number, { title: string; body: string }>,
): CampaignDeps["fetchIssue"] {
	return (n) => {
		const i = issues[n];
		if (!i) throw new Error(`no fake issue #${n}`);
		return Promise.resolve({ number: n, title: i.title, body: i.body });
	};
}

function makeDeps(over: Partial<CampaignDeps> = {}): CampaignDeps {
	return {
		fetchIssue: fakeFetch({
			9: { title: "Finish v0 docs", body: "update docs and the readme" },
			3: { title: "Improve converge driver", body: "core converge work" },
		}),
		runTask: () =>
			Promise.resolve<TaskRunOutcome>({
				loopStatus: "converged",
				finalVerdict: "proceed",
				iterations: 2,
				changedFiles: ["apps/cli/src/cli/converge.ts"],
				auditRunIds: ["run-1"],
				summary: "did it",
			}),
		git: makeGit().git,
		now: () => Date.parse("2026-06-01T00:00:00.000Z"),
		worktreeRootDir: wtRoot,
		...over,
	};
}

describe("campaign start", () => {
	test("creates a campaign file from two fake issues, classified pending", async () => {
		const { io, out } = makeIO();
		const code = await runCampaign(
			["start", "--issues", "9,3", "--repo", repo, "--id", "v0"],
			io,
			makeDeps(),
		);
		expect(code).toBe(0);
		expect(campaignExists(repo, "v0")).toBe(true);
		const c = readCampaign(repo, "v0");
		expect(c.tasks.map((t) => t.id)).toEqual(["issue-9", "issue-3"]);
		expect(c.tasks.every((t) => t.status === "pending")).toBe(true);
		expect(c.baseSha).toBe("deadbeefcafef00d");
		expect(out.join("")).toContain("created v0");
	});

	test("refuses overlapping path claims and writes no campaign", async () => {
		const { io, err } = makeIO();
		const deps = makeDeps({
			fetchIssue: fakeFetch({
				7: { title: "MCP audit tools", body: "audit surface" },
				11: { title: "audit retention", body: "audit store" },
			}),
		});
		const code = await runCampaign(
			["start", "--issues", "7,11", "--repo", repo, "--id", "ov"],
			io,
			deps,
		);
		expect(code).toBe(1);
		expect(err.join("")).toMatch(/overlapping paths/);
		expect(campaignExists(repo, "ov")).toBe(false);
	});

	test("rejects --max-parallel above the cap", async () => {
		const { io, err } = makeIO();
		const code = await runCampaign(
			["start", "--issues", "9", "--max-parallel", "3", "--repo", repo],
			io,
			makeDeps(),
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/capped at 2/);
	});

	test("fetches issues scoped to the resolved campaign repo (not the cwd)", async () => {
		const seenRepos: string[] = [];
		const deps = makeDeps({
			fetchIssue: (n, r) => {
				seenRepos.push(r);
				return Promise.resolve({ number: n, title: "Finish v0 docs", body: "" });
			},
		});
		await runCampaign(
			["start", "--issues", "9", "--repo", repo, "--id", "scoped"],
			makeIO().io,
			deps,
		);
		// resolveRepo returns the git toplevel (our fake returns `repo`); the fetch
		// must be scoped to it, not to process.cwd().
		expect(seenRepos).toEqual([repo]);
	});

	test("an unclassifiable issue is recorded needs_human, not run", async () => {
		const { io } = makeIO();
		const deps = makeDeps({
			fetchIssue: fakeFetch({ 5: { title: "Rework billing", body: "no keywords" } }),
		});
		await runCampaign(["start", "--issues", "5", "--repo", repo, "--id", "nh"], io, deps);
		const c = readCampaign(repo, "nh");
		expect(c.tasks[0]?.status).toBe("needs_human");
	});
});

describe("campaign run", () => {
	async function start(id: string, deps: CampaignDeps, issues = "9,3"): Promise<void> {
		const { io } = makeIO();
		const code = await runCampaign(
			["start", "--issues", issues, "--repo", repo, "--id", id],
			io,
			deps,
		);
		if (code !== 0) throw new Error("start failed");
	}

	test("records the converge loop result into task state", async () => {
		const deps = makeDeps();
		await start("r1", deps);
		const { io } = makeIO();
		const code = await runCampaign(["run", "r1", "--repo", repo], io, deps);
		expect(code).toBe(0);
		const c = readCampaign(repo, "r1");
		const t = c.tasks.find((x) => x.id === "issue-9");
		expect(t?.status).toBe("review_ready");
		expect(t?.result?.loopStatus).toBe("converged");
		expect(t?.result?.finalVerdict).toBe("proceed");
		expect(t?.result?.auditRunIds).toEqual(["run-1"]);
		expect(t?.loopId).toBe("r1-issue-9");
		// Claims were replaced with the actual change set from the run.
		expect(t?.claimedPaths).toEqual(["apps/cli/src/cli/converge.ts"]);
	});

	test("marks a task blocked when converge returns block", async () => {
		const deps = makeDeps({
			runTask: () =>
				Promise.resolve<TaskRunOutcome>({
					loopStatus: "blocked",
					finalVerdict: "block",
					iterations: 1,
					changedFiles: [],
					auditRunIds: [],
					summary: "blocked",
				}),
		});
		await start("r2", deps);
		const { io } = makeIO();
		await runCampaign(["run", "r2", "--repo", repo], io, deps);
		const c = readCampaign(repo, "r2");
		expect(c.tasks.find((t) => t.id === "issue-9")?.status).toBe("blocked");
		expect(c.status).toBe("needs_human");
	});

	test("marks a task failed when the converge run itself fails", async () => {
		const deps = makeDeps({
			runTask: () =>
				Promise.resolve<TaskRunOutcome>({
					loopStatus: "blocked",
					iterations: 0,
					changedFiles: [],
					auditRunIds: [],
					summary: "",
					runFailed: true,
					error: "chit converge: codex exited 1",
				}),
		});
		await start("r3", deps);
		const { io } = makeIO();
		await runCampaign(["run", "r3", "--repo", repo], io, deps);
		const c = readCampaign(repo, "r3");
		expect(c.tasks.find((t) => t.id === "issue-9")?.status).toBe("failed");
		expect(c.status).toBe("failed");
	});

	test("does not auto-merge: converged tasks stay review_ready and print merge instructions", async () => {
		const deps = makeDeps();
		await start("r4", deps);
		const { io, out } = makeIO();
		await runCampaign(["run", "r4", "--repo", repo], io, deps);
		const c = readCampaign(repo, "r4");
		expect(c.tasks.every((t) => t.status !== "merged" && t.status !== "merge_ready")).toBe(true);
		expect(out.join("")).toMatch(/merge into main yourself/);
	});

	test("a needs_human task is never run", async () => {
		const params: TaskRunParams[] = [];
		const deps = makeDeps({
			fetchIssue: fakeFetch({ 5: { title: "Rework billing", body: "no keywords" } }),
			runTask: (p) => {
				params.push(p);
				return Promise.resolve<TaskRunOutcome>({
					loopStatus: "converged",
					iterations: 1,
					changedFiles: [],
					auditRunIds: [],
					summary: "",
				});
			},
		});
		await start("r5", deps, "5");
		const { io } = makeIO();
		await runCampaign(["run", "r5", "--repo", repo], io, deps);
		expect(params).toHaveLength(0); // runTask never invoked
		expect(readCampaign(repo, "r5").tasks[0]?.status).toBe("needs_human");
	});

	test("a dirty worktree blocks the task (no run) unless --allow-dirty", async () => {
		const ran: TaskRunParams[] = [];
		const deps = makeDeps({
			git: makeGit({ dirty: true }).git,
			runTask: (p) => {
				ran.push(p);
				return Promise.resolve<TaskRunOutcome>({
					loopStatus: "converged",
					iterations: 1,
					changedFiles: [],
					auditRunIds: [],
					summary: "",
				});
			},
		});
		await start("r6", deps, "9");
		const { io } = makeIO();
		await runCampaign(["run", "r6", "--repo", repo], io, deps);
		expect(ran).toHaveLength(0);
		const t = readCampaign(repo, "r6").tasks[0];
		expect(t?.status).toBe("blocked");
		expect(t?.error).toMatch(/dirty/);
	});

	test("runs both tasks across batches with max-parallel 1", async () => {
		const scopes: string[] = [];
		const deps = makeDeps({
			runTask: (p) => {
				scopes.push(p.scope);
				return Promise.resolve<TaskRunOutcome>({
					loopStatus: "converged",
					iterations: 1,
					changedFiles: [],
					auditRunIds: [],
					summary: "",
				});
			},
		});
		// max-parallel defaults to 1.
		await start("r7", deps);
		const { io } = makeIO();
		await runCampaign(["run", "r7", "--repo", repo], io, deps);
		expect(scopes.sort()).toEqual(["campaign-r7-issue-3", "campaign-r7-issue-9"]);
		const c = readCampaign(repo, "r7");
		expect(c.tasks.every((t) => t.status === "review_ready")).toBe(true);
		// All converged but not yet merged: chit is done, a human still must merge.
		expect(c.status).toBe("ready_for_review");
	});

	test("an explicit --claim lets a title-unclassifiable issue run", async () => {
		const ran: string[] = [];
		const deps = makeDeps({
			fetchIssue: fakeFetch({ 9: { title: "Decide Chit distribution", body: "no title keyword" } }),
			runTask: (p) => {
				ran.push(p.scope);
				return Promise.resolve<TaskRunOutcome>({
					loopStatus: "converged",
					iterations: 1,
					changedFiles: [],
					auditRunIds: [],
					summary: "",
				});
			},
		});
		const { io: sio } = makeIO();
		const startCode = await runCampaign(
			[
				"start",
				"--issues",
				"9",
				"--repo",
				repo,
				"--id",
				"cl",
				"--claim",
				"issue-9=README.md,notes/**",
			],
			sio,
			deps,
		);
		expect(startCode).toBe(0);
		expect(readCampaign(repo, "cl").tasks[0]?.status).toBe("pending");
		const { io } = makeIO();
		await runCampaign(["run", "cl", "--repo", repo], io, deps);
		expect(ran).toEqual(["campaign-cl-issue-9"]);
		expect(readCampaign(repo, "cl").tasks[0]?.status).toBe("review_ready");
	});

	test("a --claim for an issue not in the campaign is a usage error", async () => {
		const { io, err } = makeIO();
		const code = await runCampaign(
			["start", "--issues", "9", "--repo", repo, "--claim", "issue-42=README.md"],
			io,
			makeDeps({ fetchIssue: fakeFetch({ 9: { title: "Finish v0 docs", body: "" } }) }),
		);
		expect(code).toBe(2);
		expect(err.join("")).toMatch(/no such task/);
	});
});

describe("campaign status / inspect / restart", () => {
	test("status renders an incomplete campaign (mixed task states) without error", async () => {
		const deps = makeDeps({
			fetchIssue: fakeFetch({
				9: { title: "docs", body: "readme" },
				5: { title: "Rework billing", body: "no keywords" }, // needs_human
			}),
		});
		const { io: sio } = makeIO();
		await runCampaign(["start", "--issues", "9,5", "--repo", repo, "--id", "mix"], sio, deps);
		const { io, out } = makeIO();
		const code = await runCampaign(["status", "mix", "--repo", repo], io, deps);
		expect(code).toBe(0);
		const text = out.join("");
		expect(text).toContain("campaign mix");
		expect(text).toContain("issue-9");
		expect(text).toContain("needs_human");
	});

	test("survives a restart: state written by run is read back by a fresh status call", async () => {
		const deps = makeDeps();
		const { io: sio } = makeIO();
		await runCampaign(["start", "--issues", "9", "--repo", repo, "--id", "rst"], sio, deps);
		const { io: rio } = makeIO();
		await runCampaign(["run", "rst", "--repo", repo], rio, deps);
		// Fresh status invocation (separate "process"): reads the persisted file.
		const { io, out } = makeIO();
		await runCampaign(["status", "rst", "--repo", repo], io, deps);
		expect(out.join("")).toContain("review_ready");
		expect(out.join("")).toContain("status ready_for_review");
	});

	test("inspect prints loop id, audit ref, and change set for a task", async () => {
		const deps = makeDeps();
		const { io: sio } = makeIO();
		await runCampaign(["start", "--issues", "9", "--repo", repo, "--id", "ins"], sio, deps);
		const { io: rio } = makeIO();
		await runCampaign(["run", "ins", "--repo", repo], rio, deps);
		const { io, out } = makeIO();
		const code = await runCampaign(
			["inspect", "ins", "--task", "issue-9", "--repo", repo],
			io,
			deps,
		);
		expect(code).toBe(0);
		const text = out.join("");
		expect(text).toContain("task issue-9");
		expect(text).toContain("loop    ins-issue-9");
		expect(text).toContain("chit audit show run-1");
	});

	test("inspect on an unknown task errors cleanly", async () => {
		const deps = makeDeps();
		const { io: sio } = makeIO();
		await runCampaign(["start", "--issues", "9", "--repo", repo, "--id", "ins2"], sio, deps);
		const { io, err } = makeIO();
		const code = await runCampaign(
			["inspect", "ins2", "--task", "issue-99", "--repo", repo],
			io,
			deps,
		);
		expect(code).toBe(1);
		expect(err.join("")).toMatch(/no task/);
	});
});

describe("outcomeFromLoop", () => {
	const header: LoopRecord = {
		type: "loop",
		schema: 1,
		loopId: "L",
		scope: "s",
		task: "t",
		repo: "/r",
		startedAt: "2026-06-01T00:00:00.000Z",
		maxIterations: 3,
	};

	test("derives review-ready signal from a converged loop with an audit ref", () => {
		const records: LoopRecord[] = [
			header,
			{
				type: "iteration",
				n: 1,
				implementSummary: "did it",
				changedFiles: ["a.ts"],
				checksRun: "bun test",
				verdict: "proceed",
				findingCount: 0,
				decision: "proceed",
				checkDurationMs: 10,
				at: "2026-06-01T00:00:01.000Z",
				detailsRef: "audit:run-xyz",
			},
			{
				type: "stop",
				status: "converged",
				reason: "ok",
				iterations: 1,
				totalElapsedMs: 20,
				endedAt: "2026-06-01T00:00:02.000Z",
			},
		];
		const o = outcomeFromLoop(records, 0);
		expect(o.loopStatus).toBe("converged");
		expect(o.finalVerdict).toBe("proceed");
		expect(o.changedFiles).toEqual(["a.ts"]);
		expect(o.auditRunIds).toEqual(["run-xyz"]);
		expect(o.runFailed).toBeUndefined();
	});

	test("a non-zero converge exit is surfaced as runFailed", () => {
		const records: LoopRecord[] = [
			header,
			{
				type: "stop",
				status: "blocked",
				reason: "manifest run failed",
				iterations: 0,
				totalElapsedMs: 5,
				endedAt: "2026-06-01T00:00:02.000Z",
			},
		];
		const o = outcomeFromLoop(records, 1, ["chit converge: codex exited 1\n"]);
		expect(o.runFailed).toBe(true);
		expect(o.error).toMatch(/codex exited 1/);
	});
});
