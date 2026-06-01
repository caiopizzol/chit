import { describe, expect, test } from "bun:test";
import { startMcpServer } from "./server.ts";

// The MCP server module must be importable WITHOUT starting a server: the CLI
// binary imports it to expose `chit mcp`, so a top-level `server.connect(...)`
// (the old shape) would connect this test's stdio and hang the suite. That this
// file imports the module and runs at all proves the connect is now gated behind
// startMcpServer(). We also assert the exported entrypoint exists.
describe("mcp server module", () => {
	test("exports startMcpServer and importing it does not start a server", () => {
		expect(typeof startMcpServer).toBe("function");
	});
});
