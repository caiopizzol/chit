import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Read the child's stdout until `pattern` matches, then return the full text
// seen so far. Rejects if the process exits or the timeout elapses first, so a
// boot failure surfaces as a test error rather than a hang.
async function readUntil(
	proc: ReturnType<typeof Bun.spawn>,
	pattern: RegExp,
	timeoutMs: number,
): Promise<string> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Bun.sleep(timeoutMs).then(() => {
		throw new Error(`timed out waiting for ${pattern}; saw: ${buf}`);
	});
	const pump = (async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`process exited before ${pattern}; saw: ${buf}`);
			buf += decoder.decode(value, { stream: true });
			if (pattern.test(buf)) return buf;
		}
	})();
	try {
		return await Promise.race([pump, deadline]);
	} finally {
		reader.releaseLock();
	}
}

describe("packaged chit studio", () => {
	test("serves the client bundle from the packaged location (no 503)", async () => {
		// The build copies the Studio client beside chit.js; assert it landed.
		expect(existsSync(join(APPS_CLI, "dist", "client", "index.js"))).toBe(true);
		expect(existsSync(join(APPS_CLI, "dist", "client", "index.css"))).toBe(true);

		const cwd = mkdtempSync(join(tmpdir(), "chit-studio-pkg-"));
		const proc = Bun.spawn(["bun", DIST, "studio"], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const out = await readUntil(proc, /chit studio: (http:\/\/\S+)/, 15000);
			const url = out.match(/chit studio: (http:\/\/\S+)/)?.[1] as string;
			// The 503 path the published package used to hit lives behind /client/.
			const js = await fetch(new URL("/client/index.js", url));
			expect(js.status).toBe(200);
			expect((await js.text()).length).toBeGreaterThan(0);
			const css = await fetch(new URL("/client/index.css", url));
			expect(css.status).toBe(200);
		} finally {
			proc.kill("SIGINT");
			await proc.exited;
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 30000);
});

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

	// The release-boundary contract: the packaged binary exposes EXACTLY the 23
	// unified tools (16 run/batch/audit + 6 plan + 1 config/recipes) and ZERO of the
	// removed run/converge/job or draft tool names.
	test("tools/list is exactly the 23 unified tools, with no removed names", async () => {
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
		const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
		proc.stdin.write(`${JSON.stringify(init)}\n`);
		proc.stdin.write(`${JSON.stringify(list)}\n`);
		proc.stdin.end();
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		// Extract the registered tool names from the `name` field of each tool entry
		// (precise: a description mentioning a tool is not a `"name":"..."` match).
		const names = [...out.matchAll(/"name":"(chit_[a-z_]+)"/g)].map((m) => m[1] as string);
		const unique = [...new Set(names)].sort();
		expect(unique).toEqual([
			"chit_apply",
			"chit_audit_list",
			"chit_audit_show",
			"chit_batch_advance",
			"chit_batch_cancel",
			"chit_batch_cleanup",
			"chit_batch_list",
			"chit_batch_start",
			"chit_batch_status",
			"chit_cancel",
			"chit_cleanup",
			"chit_next",
			"chit_plan_advance",
			"chit_plan_cancel",
			"chit_plan_cleanup",
			"chit_plan_list",
			"chit_plan_start",
			"chit_plan_status",
			"chit_recipes",
			"chit_start",
			"chit_status",
			"chit_trace",
			"chit_wait",
		]);
		// No removed run/converge/job tool families survive anywhere in the surface.
		expect(unique.some((n) => /^chit_(run|converge|job)_/.test(n))).toBe(false);
		// The draft preview/launch tools are gone: native plan execution is the only plan surface.
		expect(unique.some((n) => /^chit_draft_/.test(n))).toBe(false);
	}, 20000);
});
