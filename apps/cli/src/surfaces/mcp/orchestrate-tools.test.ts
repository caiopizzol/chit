import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "./server.ts";

// Drive the registered MCP surface over an in-memory transport (no stdio, no spawned
// workers, no model): this asserts chit_orchestrate is registered and that a call missing
// the required `goal` is rejected by input validation BEFORE the handler runs, so the
// planner manifest is never executed. The composition itself (run planner -> parse ->
// validate -> dry-run -> shape result) is unit-tested with fakes in orchestrate.test.ts;
// here we only pin the transport-level registration and the required-input gate.
let client: Client;
let stateDir: string;
let savedXdg: string | undefined;

beforeAll(async () => {
	// Isolate any state the deps might touch so the test never reads the real ~/.local/state.
	stateDir = mkdtempSync(join(tmpdir(), "chit-orchestrate-tools-state-"));
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

describe("orchestrate tool registration", () => {
	test("the tool list includes chit_orchestrate with its goal/context/base_branch/max_iterations inputs", async () => {
		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "chit_orchestrate");
		expect(tool).toBeDefined();
		const props = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		expect(props.goal).toBeDefined();
		expect(props.context).toBeDefined();
		expect(props.base_branch).toBeDefined();
		expect(props.max_iterations).toBeDefined();
		// goal is the only required input.
		const required = (tool?.inputSchema as { required?: string[] }).required ?? [];
		expect(required).toContain("goal");
	});

	test("calling chit_orchestrate without a goal errors before any planner run", async () => {
		// The required-input gate is schema-level: the SDK validates arguments against the zod
		// inputSchema and returns an error result, so the handler (and thus the real planner
		// manifest) never runs. No model is invoked.
		const result = (await client.callTool({ name: "chit_orchestrate", arguments: {} })) as {
			isError?: boolean;
			content: Array<{ type: string; text?: string }>;
		};
		expect(result.isError).toBe(true);
		// The validation message names the missing required field.
		expect(result.content.map((c) => c.text ?? "").join("")).toContain("goal");
	});
});
