import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Packaged-distribution smoke: build the CLI exactly as `prepack` does, then run
// the bundled binary. This guards the v0 distribution contract:
//   - `chit --help` returns (the bundled MCP module must NOT auto-start a server
//     on import, or every `chit` invocation would hang on stdio);
//   - `chit mcp` boots a working stdio MCP server from the single binary.
// Builds once for the file (a few seconds), so it lives apart from the fast unit
// tests.

const APPS_CLI = join(import.meta.dir, "..", "..", "..");
const DIST = join(APPS_CLI, "dist", "chit.js");

const build = Bun.spawnSync(["bun", "build.ts"], { cwd: APPS_CLI });
if (!build.success) {
	throw new Error(`build failed: ${build.stderr.toString()}`);
}

describe("packaged chit binary", () => {
	test("chit --help returns without hanging on the bundled MCP server", async () => {
		const proc = Bun.spawn(["bun", DIST, "--help"], { stdin: "ignore", stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		expect(code).toBe(0);
		expect(out).toContain("Usage:");
		expect(out).toContain("chit mcp");
	});

	test("chit mcp boots a stdio MCP server that answers initialize", async () => {
		const proc = Bun.spawn(["bun", DIST, "mcp"], { stdin: "pipe", stdout: "pipe" });
		const init = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "packaged-smoke", version: "0" },
			},
		};
		proc.stdin.write(`${JSON.stringify(init)}\n`);
		// Closing stdin lets the stdio transport end, so the server exits and we read
		// its full response rather than blocking forever.
		proc.stdin.end();
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		// A valid initialize result names the server and advertises tool support.
		expect(out).toContain('"serverInfo"');
		expect(out).toContain('"name":"chit"');
		expect(out).toContain('"tools"');
	}, 20000);
});
