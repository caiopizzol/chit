import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopRecord } from "@chit-run/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLoop } from "../../loops/log-store.ts";
import { effectiveStartKnobs, server } from "./server.ts";

// chit_start can launch a vetted config recipe directly (recipes were converge-only
// orchestration before, reachable only through plan/batch). These tests drive the real
// handler over an in-memory transport and pin the new surface: the tool advertises a
// `recipe` input mutually exclusive with `manifest_path`, an unknown recipe is refused
// through the same resolver plan/batch use, the effective-budget precedence (explicit >
// recipe default > built-in fallback) is the batch gate's, and a SUCCESSFUL foreground
// start stamps the recipe through the run view + loop header with the recipe's default
// budgets (overridable by explicit knobs). The successful start uses an all-read-only
// converge recipe so it runs in_place (no managed worktree) and never spawns an agent:
// chit_next is never called, so no adapter runs. The foreground deleted-working-copy
// regression here is mirrored for the BACKGROUND execution path in jobs/worker.test.ts
// ("recipe-backed manifestText read point"): the worker executes the resolver-bound bytes
// the job persisted, never re-reading the caller working tree.

let client: Client;
let stateDir: string;
let saved: Record<string, string | undefined>;
const repoDirs: string[] = [];

beforeAll(async () => {
	stateDir = mkdtempSync(join(tmpdir(), "chit-recipe-start-state-"));
	saved = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_STATE_HOME: process.env.XDG_STATE_HOME,
	};
	process.env.XDG_CONFIG_HOME = stateDir;
	process.env.XDG_STATE_HOME = stateDir;
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([client.connect(clientT), server.connect(serverT)]);
});

afterAll(async () => {
	await client.close();
	await server.close();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(stateDir, { recursive: true, force: true });
	for (const d of repoDirs) rmSync(d, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text ?? "").join("");
}
function bodyOf(result: ToolResult): Record<string, unknown> {
	return JSON.parse(textOf(result)) as Record<string, unknown>;
}

// A complete converge manifest whose participants are BOTH read-only, so a recipe-backed
// loop run is provably non-writing: planManagedWorkspace runs it in_place (no managed
// worktree, no side effects under ~/worktrees) and the start never spawns an agent (only
// chit_next would). It references the built-in `codex` agent, so it resolves against the
// default registry without the test config defining any agent.
const CONVERGE_MANIFEST = {
	schema: 1,
	id: "recipe-converge",
	description: "read-only converge preset for recipe-start tests",
	inputs: { task: { type: "string" }, prior_review: { type: "string", optional: true } },
	participants: {
		impl: {
			agent: "codex",
			instructions: "Implement.",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
		},
		rev: {
			agent: "codex",
			instructions: "Review.",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
		},
	},
	steps: {
		implement: { call: "impl", prompt: "{{ inputs.task }}" },
		review: { call: "rev", prompt: "{{ steps.implement.output }}" },
		out: { format: "{{ steps.review.output }}" },
	},
	output: "out",
	policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
};

const ONE_SHOT_MANIFEST = {
	schema: 1,
	id: "recipe-grill",
	description: "read-only one-shot recipe for recipe-start tests",
	inputs: { idea: { type: "string" } },
	participants: {
		griller: {
			agent: "codex",
			instructions: "Ask clarifying questions.",
			session: "per_scope",
			permissions: { filesystem: "read_only" },
		},
	},
	steps: {
		grill: { call: "griller", prompt: "{{ inputs.idea }}" },
		out: { format: "{{ steps.grill.output }}" },
	},
	output: "out",
};

// The loop log header (records[0]) carries the run's effective maxIterations and the
// stamped recipe receipt; read it back from the in_place run cwd (the repo itself).
function loopHeader(cwd: string, runId: string): LoopRecord {
	const records = readLoop(cwd, runId);
	return records[0] as LoopRecord;
}

// A git repo whose committed chit.config.json defines `recipes`, plus the committed
// converge manifest a recipe binds to (the recipe binding reads the manifest from the
// git TREE at HEAD, so it must be committed, and resolving HEAD needs at least one commit).
function makeRecipeRepo(recipes: Record<string, unknown>): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "chit-recipe-start-repo-")));
	repoDirs.push(dir);
	mkdirSync(join(dir, "manifests"), { recursive: true });
	writeFileSync(join(dir, "manifests", "converge.json"), JSON.stringify(CONVERGE_MANIFEST));
	writeFileSync(join(dir, "manifests", "grill.json"), JSON.stringify(ONE_SHOT_MANIFEST));
	writeFileSync(join(dir, "chit.config.json"), JSON.stringify({ recipes }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return dir;
}

async function start(args: Record<string, unknown>): Promise<ToolResult> {
	return (await client.callTool({ name: "chit_start", arguments: args })) as ToolResult;
}

describe("chit_start recipe input: tool schema", () => {
	test("advertises a `recipe` input alongside task / manifest_path, and max_iterations is optional", async () => {
		const { tools } = await client.listTools();
		const startTool = tools.find((t) => t.name === "chit_start");
		const schema = startTool?.inputSchema as {
			properties?: Record<string, { description?: string }>;
			required?: string[];
		};
		const props = schema.properties ?? {};
		expect(Object.keys(props)).toContain("recipe");
		// The recipe and manifest_path descriptions both name the mutual exclusion, so a
		// caller cannot pass both without warning.
		expect(props.recipe?.description ?? "").toContain("Mutually exclusive with manifest_path");
		expect(props.manifest_path?.description ?? "").toContain("Mutually exclusive with recipe");
		// max_iterations carries no schema default now (a recipe's default can apply); it is
		// never required.
		expect(schema.required ?? []).not.toContain("max_iterations");
	});
});

describe("chit_start recipe input: mutual exclusion", () => {
	test("passing both recipe and manifest_path is refused before any resolution", async () => {
		const r = await start({
			recipe: "deep-feature",
			manifest_path: "./whatever.json",
			task: "do it",
			scope: "s",
			cwd: stateDir,
		});
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("mutually exclusive");
	});
});

describe("chit_start recipe input: unknown recipe", () => {
	test("an unrecognized recipe id is refused through the shared resolver, listing the known ones", async () => {
		const repo = makeRecipeRepo({
			"deep-feature": { mode: "converge", manifestPath: "manifests/converge.json" },
		});
		const r = await start({
			recipe: "does-not-exist",
			task: "do it",
			scope: "s",
			mode: "background",
			cwd: repo,
		});
		expect(r.isError).toBe(true);
		const text = textOf(r);
		expect(text).toContain("unknown recipe");
		// The resolver lists what IS configured, so the caller can self-correct.
		expect(text).toContain("deep-feature");
	});
});

describe("chit_start recipe input: one-shot recipes", () => {
	const RECIPE = {
		grill: {
			mode: "one-shot",
			manifestPath: "manifests/grill.json",
			description: "question loop",
		},
	};

	async function cancel(runId: unknown): Promise<void> {
		if (typeof runId === "string") {
			await client.callTool({ name: "chit_cancel", arguments: { run_id: runId } });
		}
	}

	test("a recipe-backed foreground start runs the bound one-shot manifest", async () => {
		const repo = makeRecipeRepo(RECIPE);
		rmSync(join(repo, "manifests", "grill.json"));
		const r = await start({
			recipe: "grill",
			mode: "foreground",
			cwd: repo,
			scope: "grill-scope",
			inputs: { idea: "Add a custom onboarding routine" },
			allow_unenforced_permissions: true,
		});
		expect(r.isError).toBeUndefined();
		const body = bodyOf(r);
		expect(body.execution).toBe("one-shot");
		expect(body.manifest).toBe("recipe-grill");
		expect(body.ready).toEqual([
			{ step: "grill", kind: "call", participant: "griller", agent: "codex", session: "per_scope" },
		]);
		await cancel(body.run_id);
	});

	test("a one-shot recipe rejects task and loop knobs", async () => {
		const repo = makeRecipeRepo(RECIPE);
		const withTask = await start({
			recipe: "grill",
			task: "do it",
			mode: "foreground",
			cwd: repo,
			inputs: { idea: "x" },
			allow_unenforced_permissions: true,
		});
		expect(withTask.isError).toBe(true);
		expect(textOf(withTask)).toContain("does not take a `task`");

		const withBudget = await start({
			recipe: "grill",
			mode: "foreground",
			cwd: repo,
			inputs: { idea: "x" },
			max_iterations: 2,
			allow_unenforced_permissions: true,
		});
		expect(withBudget.isError).toBe(true);
		expect(textOf(withBudget)).toContain("max_iterations applies only to a loop run");
	});

	test("a recipe mode that disagrees with the manifest policy is refused", async () => {
		const repo = makeRecipeRepo({
			mismatch: { mode: "one-shot", manifestPath: "manifests/converge.json" },
		});
		const r = await start({
			recipe: "mismatch",
			mode: "foreground",
			cwd: repo,
			inputs: { idea: "x" },
			allow_unenforced_permissions: true,
		});
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("declares mode one-shot but its manifest policy is loop");
	});
});

describe("chit_start recipe input: successful foreground start stamps the receipt + budgets", () => {
	// The recipe's own defaults: the run inherits these when the tool inputs omit them.
	const RECIPE = {
		"ro-recipe": {
			mode: "converge",
			manifestPath: "manifests/converge.json",
			maxIterations: 7,
			callTimeoutMs: 900_000,
			description: "read-only converge preset",
		},
	};

	async function cancel(runId: unknown): Promise<void> {
		if (typeof runId !== "string") return;
		// Best-effort: settle the in-memory foreground session so it does not linger in the
		// shared run controller for sibling suites. The loop log lives in the isolated state dir.
		await client.callTool({ name: "chit_cancel", arguments: { run_id: runId } });
	}

	test("a recipe-backed foreground start runs as a loop and inherits the recipe's default budgets", async () => {
		const repo = makeRecipeRepo(RECIPE);
		const r = await start({
			recipe: "ro-recipe",
			task: "do the slice",
			scope: "s",
			mode: "foreground",
			cwd: repo,
			// Read-only participants under an adapter that may not enforce read_only would be an
			// enforcement gap; the recipe path is otherwise unrelated, so allow it to surface as
			// a warning rather than blocking this wiring test.
			allow_unenforced_permissions: true,
		});
		expect(r.isError).toBeUndefined();
		const body = bodyOf(r);
		// The run view answers what launched: a foreground converge loop, stamped with the recipe.
		expect(body.execution).toBe("loop");
		expect(body.mode).toBe("foreground");
		expect(body.recipe).toBe("ro-recipe");
		// No explicit call_timeout_ms -> the recipe's default is the effective per-call budget.
		expect(body.callTimeoutMs).toBe(900_000);

		// The durable loop header carries the full receipt AND the effective iteration budget.
		const header = loopHeader(repo, body.run_id as string) as {
			maxIterations: number;
			recipe?: { id: string; maxIterations?: number; callTimeoutMs?: number };
		};
		expect(header.recipe?.id).toBe("ro-recipe");
		expect(header.recipe?.maxIterations).toBe(7);
		expect(header.recipe?.callTimeoutMs).toBe(900_000);
		// Effective budget with no explicit input is the recipe's default.
		expect(header.maxIterations).toBe(7);

		await cancel(body.run_id);
	});

	test("explicit max_iterations / call_timeout_ms override the recipe's defaults, but the receipt records the recipe's own", async () => {
		const repo = makeRecipeRepo(RECIPE);
		const r = await start({
			recipe: "ro-recipe",
			task: "do the slice",
			scope: "s2",
			mode: "foreground",
			cwd: repo,
			allow_unenforced_permissions: true,
			max_iterations: 1,
			call_timeout_ms: 12_345,
		});
		expect(r.isError).toBeUndefined();
		const body = bodyOf(r);
		// Explicit call timeout is the closest override, surfaced on the run view.
		expect(body.callTimeoutMs).toBe(12_345);

		const header = loopHeader(repo, body.run_id as string) as {
			maxIterations: number;
			recipe?: { id: string; maxIterations?: number };
		};
		// The run's effective budget is the explicit input...
		expect(header.maxIterations).toBe(1);
		// ...while the stamped receipt still records the recipe's OWN declared default (7),
		// so status/audit can show both what ran and what the recipe vouched for.
		expect(header.recipe?.id).toBe("ro-recipe");
		expect(header.recipe?.maxIterations).toBe(7);

		await cancel(body.run_id);
	});

	test("a committed recipe still starts when the caller checkout's manifest copy is missing (read point is the git tree)", async () => {
		const repo = makeRecipeRepo(RECIPE);
		// Delete the working-tree copy AFTER it was committed: a repo-relative recipe is read
		// from the git tree at the run's base commit, not the caller checkout, so a dirty or
		// removed working-tree copy must not refuse a committed, valid recipe.
		rmSync(join(repo, "manifests", "converge.json"));
		const r = await start({
			recipe: "ro-recipe",
			task: "do the slice",
			scope: "s3",
			mode: "foreground",
			cwd: repo,
			allow_unenforced_permissions: true,
		});
		expect(r.isError).toBeUndefined();
		const body = bodyOf(r);
		expect(body.execution).toBe("loop");
		expect(body.recipe).toBe("ro-recipe");
		await cancel(body.run_id);
	});
});

describe("effectiveStartKnobs: explicit > recipe default > built-in fallback", () => {
	test("no explicit input and no recipe falls back to maxIterations 3, no call timeout", () => {
		expect(effectiveStartKnobs({}, undefined)).toEqual({ maxIterations: 3 });
	});

	test("a recipe's defaults apply when the tool input omits them", () => {
		expect(effectiveStartKnobs({}, { maxIterations: 8, callTimeoutMs: 1_200_000 })).toEqual({
			maxIterations: 8,
			callTimeoutMs: 1_200_000,
		});
	});

	test("explicit tool inputs are the closest override, beating the recipe's defaults", () => {
		expect(
			effectiveStartKnobs(
				{ maxIterations: 2, callTimeoutMs: 60_000 },
				{ maxIterations: 8, callTimeoutMs: 1_200_000 },
			),
		).toEqual({ maxIterations: 2, callTimeoutMs: 60_000 });
	});

	test("the override is per-knob: an explicit maxIterations can win while the recipe's timeout still applies", () => {
		expect(effectiveStartKnobs({ maxIterations: 5 }, { callTimeoutMs: 900_000 })).toEqual({
			maxIterations: 5,
			callTimeoutMs: 900_000,
		});
	});

	test("callTimeoutMs has no numeric fallback: absent everywhere, it stays unset (agent config applies)", () => {
		expect(effectiveStartKnobs({}, { maxIterations: 4 })).toEqual({ maxIterations: 4 });
	});
});
