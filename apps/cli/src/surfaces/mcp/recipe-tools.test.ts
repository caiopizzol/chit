import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "./server.ts";

// Drive the registered chit_recipes tool over an in-memory transport (no stdio):
// it loads config FRESH for the call's cwd through the same layered global + repo
// path every other tool uses, and returns the redacted recipe menu. The redaction
// shape itself is unit-tested in apps/studio/src/server/config.test.ts; here we
// assert the tool is registered and that what crosses the MCP wire is the menu
// with the right provenance and nothing more.
let client: Client;
let configDir: string;
let savedXdgConfig: string | undefined;
const repoDirs: string[] = [];

beforeAll(async () => {
	// Isolate the GLOBAL config layer so the test never reads the dev machine's
	// ~/.config/chit/config.json; each test writes the global file it wants here.
	configDir = mkdtempSync(join(tmpdir(), "chit-recipe-tools-config-"));
	savedXdgConfig = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = configDir;
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([client.connect(clientT), server.connect(serverT)]);
});

afterEach(() => {
	// Reset the global layer between tests; an absent file means "no global layer".
	rmSync(join(configDir, "chit"), { recursive: true, force: true });
});

afterAll(async () => {
	await client.close();
	await server.close();
	if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdgConfig;
	rmSync(configDir, { recursive: true, force: true });
	for (const d of repoDirs) rmSync(d, { recursive: true, force: true });
});

function writeGlobalConfig(config: unknown): string {
	const dir = join(configDir, "chit");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(config));
	return path;
}

// A fresh, non-git temp dir whose chit.config.json is the repo layer for a call.
// Returns the realpath: the loader's repo-root discovery canonicalizes the cwd
// (on macOS /var -> /private/var), so the reported repoConfigPath uses that form.
function makeRepo(config: unknown): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "chit-recipe-tools-repo-")));
	repoDirs.push(dir);
	writeFileSync(join(dir, "chit.config.json"), JSON.stringify(config));
	return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

async function callRecipes(cwd: string) {
	const result = (await client.callTool({ name: "chit_recipes", arguments: { cwd } })) as {
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	return result;
}

describe("chit_recipes registration", () => {
	test("the tool list includes chit_recipes alongside the existing tools", async () => {
		const { tools } = await client.listTools();
		const names = new Set(tools.map((t) => t.name));
		expect(names.has("chit_recipes")).toBe(true);
		// It advertises only the optional cwd input -- it is a read-only lookup.
		const recipes = tools.find((t) => t.name === "chit_recipes");
		const props =
			(recipes?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(props)).toEqual(["cwd"]);
		// The existing tools are untouched.
		expect(names.has("chit_start")).toBe(true);
		expect(names.has("chit_batch_start")).toBe(true);
		expect(names.has("chit_audit_list")).toBe(true);
	});
});

describe("chit_recipes response", () => {
	test("returns the redacted recipe menu with repo provenance and the read config path", async () => {
		const repo = makeRepo({
			recipes: {
				fix: {
					mode: "converge",
					manifestPath: "flows/fix.json",
					maxIterations: 4,
					callTimeoutMs: 900_000,
					description: "fix loop preset",
				},
				grill: {
					mode: "one-shot",
					manifestPath: "flows/grill.json",
					description: "question routine",
				},
			},
		});
		const result = await callRecipes(repo);
		expect(result.isError).toBeUndefined();
		const body = JSON.parse(textOf(result));
		expect(body.recipes).toEqual([
			{
				id: "fix",
				origin: "repo",
				mode: "converge",
				manifestPath: "flows/fix.json",
				maxIterations: 4,
				callTimeoutMs: 900_000,
				description: "fix loop preset",
			},
			{
				id: "grill",
				origin: "repo",
				mode: "one-shot",
				manifestPath: "flows/grill.json",
				description: "question routine",
			},
		]);
		// No global file was written, so only the repo config path is reported.
		expect(body.configPath).toBeUndefined();
		expect(body.repoConfigPath).toBe(join(repo, "chit.config.json"));
	});

	test("layers global + repo recipes with per-recipe origin, layer-then-id ordered", async () => {
		const globalPath = writeGlobalConfig({
			recipes: {
				"g-two": { mode: "converge", manifestPath: "/flows/two.json" },
				"g-one": { mode: "converge", manifestPath: "/flows/one.json" },
			},
		});
		const repo = makeRepo({
			recipes: { "r-one": { mode: "converge", manifestPath: "flows/repo.json" } },
		});
		const body = JSON.parse(textOf(await callRecipes(repo)));
		expect(body.recipes.map((r: { origin: string; id: string }) => `${r.origin}:${r.id}`)).toEqual([
			"global:g-one",
			"global:g-two",
			"repo:r-one",
		]);
		expect(body.configPath).toBe(globalPath);
		expect(body.repoConfigPath).toBe(join(repo, "chit.config.json"));
	});

	test("each recipe carries only the contracted fields -- no origin path or extra leakage", async () => {
		const repo = makeRepo({
			recipes: { bare: { mode: "converge", manifestPath: "flows/bare.json" } },
		});
		const body = JSON.parse(textOf(await callRecipes(repo)));
		const recipe = body.recipes[0];
		// Absent optionals stay absent (field-by-field rebuild), and the defining
		// file PATH is never attached to a recipe -- only its origin LAYER.
		expect(Object.keys(recipe).sort()).toEqual(["id", "manifestPath", "mode", "origin"]);
		expect(recipe).not.toHaveProperty("path");
	});

	test("a repo with no recipes returns an empty menu, not an error", async () => {
		const repo = makeRepo({ agents: { solo: { adapter: "codex-exec" } } });
		const result = await callRecipes(repo);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(textOf(result)).recipes).toEqual([]);
	});

	test("a malformed repo config surfaces a clean error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "chit-recipe-tools-bad-"));
		repoDirs.push(dir);
		writeFileSync(join(dir, "chit.config.json"), "{ not json");
		const result = await callRecipes(dir);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("invalid JSON");
	});
});
