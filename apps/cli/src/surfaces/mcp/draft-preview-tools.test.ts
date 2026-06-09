import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "./server.ts";

// Drive the registered MCP surface over an in-memory transport (no stdio, no spawned
// workers): this exercises the real chit_draft_preview handler. The tool is strictly
// read-only -- it parses, resolves profiles, and compiles a draft -- so unlike
// chit_plan_start it never spawns a worker and is safe to call directly here.
let client: Client;
let stateDir: string;
let configDir: string;
let savedState: string | undefined;
let savedConfig: string | undefined;

beforeAll(async () => {
	// Isolate state so a slip that DID create a plan/job/batch record would be visible
	// (and not pollute ~/.local/state), and isolate config so the profile menu is the
	// built-in default only (the dev's real config.json never leaks in).
	stateDir = mkdtempSync(join(tmpdir(), "chit-draft-preview-state-"));
	configDir = mkdtempSync(join(tmpdir(), "chit-draft-preview-config-"));
	savedState = process.env.XDG_STATE_HOME;
	savedConfig = process.env.XDG_CONFIG_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	process.env.XDG_CONFIG_HOME = configDir;
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([client.connect(clientT), server.connect(serverT)]);
});
afterAll(async () => {
	await client.close();
	await server.close();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedConfig;
	rmSync(stateDir, { recursive: true, force: true });
	rmSync(configDir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text ?? "").join("");
}
async function preview(draft: unknown): Promise<ToolResult> {
	return (await client.callTool({
		name: "chit_draft_preview",
		arguments: { draft },
	})) as ToolResult;
}

describe("chit_draft_preview registration", () => {
	test("the tool is registered alongside the plan/batch tools", async () => {
		const { tools } = await client.listTools();
		const names = new Set(tools.map((t) => t.name));
		expect(names.has("chit_draft_preview")).toBe(true);
		expect(names.has("chit_plan_start")).toBe(true);
		expect(names.has("chit_batch_start")).toBe(true);
	});
});

describe("chit_draft_preview previews a valid plan draft", () => {
	test("returns a preview and launches nothing", async () => {
		const result = await preview({
			schema: 1,
			strategy: "plan",
			title: "Wire the feature",
			steps: [
				{ id: "scaffold", title: "Scaffold", body: "Create the module" },
				{ id: "impl", title: "Implement", body: "Do the work", codeDependsOn: ["scaffold"] },
			],
		});
		expect(result.isError).toBeFalsy();
		const view = JSON.parse(textOf(result));
		expect(view.strategy).toBe("plan");
		expect(view.title).toBe("Wire the feature");
		expect(view.stepCount).toBe(2);
		expect(view.status).toBe("preview_ready");
		expect(view.plan.steps[1]).toMatchObject({
			id: "impl",
			dependsOn: ["scaffold"],
			profileId: "default",
			usesDefaultProfile: true,
		});
		// The approval surface must say it launched nothing and point at the real start tool.
		expect(view.nextAction).toContain("nothing was launched");
		expect(view.nextAction).toContain("chit_plan_start");
		expect(view.nextAction).not.toContain("same draft");

		// No plan record was created: the read-only preview must not touch the store.
		const plans = (await client.callTool({
			name: "chit_plan_list",
			arguments: { cwd: process.cwd() },
		})) as ToolResult;
		expect(JSON.parse(textOf(plans))).toEqual({ plans: [] });
	});

	test("accepts the draft as a JSON string too", async () => {
		const result = await preview(
			JSON.stringify({
				schema: 1,
				strategy: "plan",
				title: "From a string",
				steps: [{ id: "a", title: "A", body: "x" }],
			}),
		);
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result)).status).toBe("preview_ready");
	});
});

describe("chit_draft_preview previews a valid batch draft", () => {
	test("returns order-only dependencies and normalized claims", async () => {
		const result = await preview({
			schema: 1,
			strategy: "batch",
			title: "Touch two areas",
			steps: [
				{ id: "api", title: "API", body: "edit api", claimedPaths: ["./src/api/"] },
				{
					id: "web",
					title: "Web",
					body: "edit web",
					claimedPaths: ["src/web/page.ts"],
					orderDependsOn: ["api"],
				},
			],
		});
		expect(result.isError).toBeFalsy();
		const view = JSON.parse(textOf(result));
		expect(view.strategy).toBe("batch");
		expect(view.batch.tasks[0]).toMatchObject({
			id: "api",
			dependencies: [],
			claimedPaths: ["src/api/"], // leading ./ stripped, subtree slash preserved
			allowPathOverlap: false,
		});
		expect(view.batch.tasks[1]).toMatchObject({ id: "web", dependencies: ["api"] });
		expect(view.nextAction).toContain("chit_batch_start");
		expect(view.nextAction).not.toContain("these tasks");
	});
});

describe("chit_draft_preview rejects invalid drafts before any preview", () => {
	test("an unknown profile id is a clear error", async () => {
		const result = await preview({
			schema: 1,
			strategy: "plan",
			title: "Bad profile",
			steps: [{ id: "a", title: "A", body: "x", profileId: "ghost" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('unknown execution profile "ghost"');
	});

	test("a draft step with a manifestPath is rejected (a draft may not name one)", async () => {
		const result = await preview({
			schema: 1,
			strategy: "plan",
			title: "Forbidden manifestPath",
			steps: [{ id: "a", title: "A", body: "x", manifestPath: "/etc/manifest.json" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("manifestPath");
	});

	test("a batch draft with a code dependency is rejected", async () => {
		const result = await preview({
			schema: 1,
			strategy: "batch",
			title: "Bad batch",
			steps: [
				{ id: "a", title: "A", body: "x", claimedPaths: ["src/a"] },
				{ id: "b", title: "B", body: "y", claimedPaths: ["src/b"], codeDependsOn: ["a"] },
			],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("code dependencies are not allowed");
	});

	test("a non-JSON string draft reports a clean parse error", async () => {
		const result = await preview("not json {");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not valid JSON");
	});
});
