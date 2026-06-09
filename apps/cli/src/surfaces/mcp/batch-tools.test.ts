import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BatchEngineDeps } from "../../batches/engine.ts";
import type { LoopJobRecord } from "../../jobs/types.ts";
import { server, setBatchDepsForTest } from "./server.ts";

// Drive the registered MCP surface over an in-memory transport (no stdio): this exercises the
// real chit_batch_start handler across the full approval gate. The dry run (the default) and the
// refusal of a missing/stale hash mutate NOTHING and only read git to resolve the base, so they
// run against the real batchDeps. The CONFIRMED, hash-matched launch is also asserted here, but
// with fake batch deps swapped in via setBatchDepsForTest: the real deps spawn detached converge
// workers and create worktrees in the live repo, so the test substitutes in-memory deps that
// resolve git and record launches, then asserts the handler returns launched:true plus a batch view.
let client: Client;
let stateDir: string;
let savedXdg: string | undefined;

beforeAll(async () => {
	// Isolate the batch store so chit_batch_list reads an empty namespace and a dry run /
	// refusal can be proven to create no batch record, not the real ~/.local/state.
	stateDir = mkdtempSync(join(tmpdir(), "chit-batch-tools-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([client.connect(clientT), server.connect(serverT)]);
});
afterAll(async () => {
	await client.close();
	await server.close();
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(stateDir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text ?? "").join("");
}

// A single no-dependency task; the body/claim are fixed so the recomputed approval hash is
// deterministic across calls. cwd is the live repo so the handler can resolve a real base sha.
const TASKS = [{ id: "a", title: "A", body: "do a", claimedPaths: ["src/a"] }];
async function batchStart(args: Record<string, unknown>): Promise<ToolResult> {
	return (await client.callTool({
		name: "chit_batch_start",
		arguments: { tasks: TASKS, cwd: process.cwd(), ...args },
	})) as ToolResult;
}

describe("chit_batch_start exposes the universal approval gate", () => {
	test("the input schema advertises confirm and approval_hash alongside the existing inputs", async () => {
		const { tools } = await client.listTools();
		const start = tools.find((t) => t.name === "chit_batch_start");
		expect(start).toBeDefined();
		const props = (start?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		expect(props.confirm).toBeDefined();
		expect(props.approval_hash).toBeDefined();
		// The existing inputs are untouched.
		expect(props.tasks).toBeDefined();
		expect(props.max_parallel).toBeDefined();
		expect(props.base_branch).toBeDefined();
	});
});

describe("chit_batch_start dry-runs by default", () => {
	test("with confirm omitted it returns the normalized tasks, resolved base, and a hash, and creates nothing", async () => {
		const result = await batchStart({});
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(textOf(result)) as {
			launched: boolean;
			strategy: string;
			tasks: Array<{ id: string }>;
			base: { ref: string; sha: string };
			approvalHash: string;
			nextAction: string;
		};
		expect(body.launched).toBe(false);
		expect(body.strategy).toBe("batch");
		expect(body.tasks.map((t) => t.id)).toEqual(["a"]);
		// The base ref was resolved to a concrete commit (40-hex sha) the operator approves.
		expect(body.base.ref).toBe("HEAD");
		expect(body.base.sha).toMatch(/^[0-9a-f]{7,40}$/);
		expect(body.approvalHash).toMatch(/^[0-9a-f]{64}$/);
		expect(body.nextAction).toContain("confirm:true");
		// No batch record was created -- the namespace is still empty.
		const list = (await client.callTool({
			name: "chit_batch_list",
			arguments: { cwd: process.cwd() },
		})) as ToolResult;
		expect(JSON.parse(textOf(list))).toEqual({ batches: [] });
	});

	test("re-approving the same tasks, base, and knobs yields the SAME hash, so a matching hash launches", async () => {
		// Hash stability is what lets an operator pass the dry run's approvalHash back and have the
		// confirmed start accept it: identical inputs must recompute the identical hash.
		const first = JSON.parse(textOf(await batchStart({}))) as { approvalHash: string };
		const second = JSON.parse(textOf(await batchStart({}))) as { approvalHash: string };
		expect(second.approvalHash).toBe(first.approvalHash);
	});
});

// In-memory batch deps: a fake git that answers the toplevel / git-common-dir / rev-parse queries
// runBatchStart + startBatch make, plus createWorktree/launchJob that record in memory instead of
// touching the filesystem or spawning a worker. HEAD resolves to a fixed sha so the dry run and the
// confirmed start recompute the SAME approval hash. Mirrors the harness in batches/tools.test.ts.
function makeFakeBatchDeps() {
	const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
	const repo = "/fake/repo";
	const jobs = new Map<string, LoopJobRecord>();
	const launched: string[] = [];
	let seq = 0;
	const deps: BatchEngineDeps = {
		git: (args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repo}\n`);
			if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${repo}/.git\n`);
			if (args[0] === "rev-parse") return ok("sha-approved\n"); // HEAD and any ref pin here
			return ok("");
		},
		createWorktree: (_repo, cid, tid) => ({
			worktreePath: `/wt/${cid}/${tid}`,
			branch: `chit-batch/${cid}/${tid}`,
		}),
		launchJob: (p) => {
			const jobId = `job-${++seq}`;
			jobs.set(jobId, {
				runId: jobId,
				policy: "loop",
				loopId: p.loopId,
				repoKey: "k",
				cwd: p.cwd,
				...p.worktree,
				scope: p.scope,
				task: p.task,
				maxIterations: p.maxIterations,
				allowUnenforced: false,
				state: "queued",
				createdAt: "t",
				iterationsCompleted: 0,
				auditRefs: [],
			});
			launched.push(jobId);
			return { jobId, loopId: p.loopId };
		},
		getJob: (id) => jobs.get(id),
		cancelJob: () => {},
		isStale: () => false,
		loopDetail: () => ({ changedFiles: [], workspaceWarnings: [] }),
		now: () => 1000,
	};
	return { deps, launched };
}

describe("chit_batch_start launches on a matching hash", () => {
	test("confirm:true with the dry run's approval_hash launches the first wave and returns a batch view", async () => {
		// Swap in fake deps so the confirmed launch runs the SAME startBatch path the real handler
		// uses, without spawning detached workers or creating real worktrees. Restored in finally so
		// the other tests (which need the real git to resolve a base sha) are unaffected.
		const { deps, launched } = makeFakeBatchDeps();
		const restore = setBatchDepsForTest(deps);
		// Persist this batch into its OWN state namespace so the launched record does not leak into the
		// shared store the dry-run / refusal tests assert is empty (the handler reads XDG_STATE_HOME per
		// call). Restored alongside the deps in finally.
		const launchStateDir = mkdtempSync(join(tmpdir(), "chit-batch-launch-state-"));
		const launchSavedXdg = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = launchStateDir;
		try {
			// Dry run under the fake deps to get the hash the confirmed start must match.
			const dry = JSON.parse(textOf(await batchStart({}))) as { approvalHash: string };
			const result = await batchStart({ confirm: true, approval_hash: dry.approvalHash });
			expect(result.isError).toBeFalsy();
			const body = JSON.parse(textOf(result)) as {
				launched: boolean;
				batch_id: string;
				base: { ref: string; sha: string };
				approvalHash: string;
				tasks: Array<{ id: string; status: string }>;
			};
			expect(body.launched).toBe(true);
			expect(body.batch_id).toBeTruthy();
			expect(body.approvalHash).toBe(dry.approvalHash);
			// Pinned to the approved commit, and the no-dependency task launched in the first wave.
			expect(body.base.sha).toBe("sha-approved");
			expect(body.tasks.find((t) => t.id === "a")?.status).toBe("running");
			expect(launched).toHaveLength(1);
			// The launch persisted a batch record that chit_batch_list now surfaces.
			const list = (await client.callTool({
				name: "chit_batch_list",
				arguments: { cwd: process.cwd() },
			})) as ToolResult;
			const batches = (JSON.parse(textOf(list)) as { batches: Array<{ batch_id: string }> })
				.batches;
			expect(batches.some((b) => b.batch_id === body.batch_id)).toBe(true);
		} finally {
			restore();
			if (launchSavedXdg === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = launchSavedXdg;
			rmSync(launchStateDir, { recursive: true, force: true });
		}
	});
});

describe("chit_batch_start refuses a confirmed start without a matching hash", () => {
	test("confirm:true with no approval_hash is refused (and creates nothing)", async () => {
		const result = await batchStart({ confirm: true });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("requires approval_hash");
		const list = (await client.callTool({
			name: "chit_batch_list",
			arguments: { cwd: process.cwd() },
		})) as ToolResult;
		expect(JSON.parse(textOf(list))).toEqual({ batches: [] });
	});

	test("confirm:true with a stale approval_hash is refused (and creates nothing)", async () => {
		const result = await batchStart({ confirm: true, approval_hash: "deadbeef" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("does not match");
		const list = (await client.callTool({
			name: "chit_batch_list",
			arguments: { cwd: process.cwd() },
		})) as ToolResult;
		expect(JSON.parse(textOf(list))).toEqual({ batches: [] });
	});
});
