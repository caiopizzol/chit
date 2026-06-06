import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PLAN_APPLY_UNAVAILABLE } from "../../plans/tools.ts";
import { server } from "./server.ts";

// Drive the registered MCP surface over an in-memory transport (no stdio, no spawned
// workers): this exercises the real chit_plan_* handlers for the read-only and
// reject paths. chit_plan_start is deliberately NOT called here -- it spawns a detached
// converge worker; its input glue is unit-tested in plans/tools.test.ts and its engine
// behavior in plans/engine.test.ts.
let client: Client;
let stateDir: string;
let savedXdg: string | undefined;

beforeAll(async () => {
	// Isolate the plan store so chit_plan_list reads an empty namespace, not the real ~/.local/state.
	stateDir = mkdtempSync(join(tmpdir(), "chit-plan-tools-state-"));
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

describe("plan tool registration", () => {
	test("the tool list includes the new plan tools alongside the old ones", async () => {
		const { tools } = await client.listTools();
		const names = new Set(tools.map((t) => t.name));
		for (const name of [
			"chit_plan_start",
			"chit_plan_list",
			"chit_plan_status",
			"chit_plan_advance",
			"chit_plan_cancel",
		]) {
			expect(names.has(name)).toBe(true);
		}
		// The existing tools are untouched.
		expect(names.has("chit_batch_start")).toBe(true);
		expect(names.has("chit_start")).toBe(true);
	});
});

describe("chit_plan_advance rejects an apply payload (gate is the next slice)", () => {
	test("an apply payload is rejected loudly, never silently ignored", async () => {
		const result = (await client.callTool({
			name: "chit_plan_advance",
			arguments: { plan_id: "nope", apply: { step_id: "a", confirm: true } },
		})) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(`error: ${PLAN_APPLY_UNAVAILABLE}`);
	});
});

describe("read-only plan tools do not launch", () => {
	test("chit_plan_list on a repo with no plans returns an empty list", async () => {
		const result = (await client.callTool({
			name: "chit_plan_list",
			arguments: { cwd: process.cwd() },
		})) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result))).toEqual({ plans: [] });
	});

	test("chit_plan_status on an unknown plan_id reports cleanly without mutating", async () => {
		const result = (await client.callTool({
			name: "chit_plan_status",
			arguments: { plan_id: "does-not-exist", cwd: process.cwd() },
		})) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("unknown plan_id does-not-exist");
	});
});
