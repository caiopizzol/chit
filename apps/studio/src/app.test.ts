// Route tests for chit-studio. Use Hono's app.fetch directly (no server
// boot needed). Runs from apps/studio with bun test.

import { describe, expect, test } from "bun:test";
import { app } from "./app";

async function get(path: string): Promise<Response> {
	return app.fetch(new Request(`http://localhost${path}`));
}

describe("home + healthz", () => {
	test("GET / returns the inspect form", async () => {
		const res = await get("/");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("Inspect a chit");
		expect(text).toContain("chit studio");
		expect(text).toContain("Track A");
	});

	test("GET /healthz returns ok", async () => {
		const res = await get("/healthz");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	test("GET / lists the canonical examples", async () => {
		const res = await get("/");
		const text = await res.text();
		expect(text).toContain("apps/cli/examples/consult.json");
		expect(text).toContain("apps/cli/examples/investigate-bug.json");
	});
});

describe("/inspect: happy paths", () => {
	test("no path query redirects to /", async () => {
		const res = await get("/inspect");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
	});

	test("relative path to a valid example renders the graph", async () => {
		// This is the case that was broken before workspace-root resolution
		// existed: the quick-link target resolved against process.cwd()
		// instead of the workspace root and returned 400.
		const res = await get("/inspect?path=apps/cli/examples/consult.json");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text.trim().startsWith("<!DOCTYPE html>")).toBe(true);
		expect(text).toContain("<title>chit: consult</title>");
		expect(text).toContain("ask_codex");
		expect(text).toContain("ask_claude");
	});

	test("the investigate-bug example renders too", async () => {
		const res = await get("/inspect?path=apps/cli/examples/investigate-bug.json");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("<title>chit: investigate-bug</title>");
	});

	test("surface=claude-skill renders with validation warning block", async () => {
		const res = await get("/inspect?path=apps/cli/examples/consult.json&surface=claude-skill");
		expect(res.status).toBe(200);
		// consult's claude participant requires read_only filesystem, and
		// claude-cli cannot enforce it; show should render a warning block.
		const text = await res.text();
		expect(text).toContain('class="validation warn"');
		expect(text).toContain("needs_override");
		expect(text).toContain("cannot enforce");
	});
});

describe("/inspect: error paths", () => {
	test("missing file returns 404 with error page", async () => {
		const res = await get("/inspect?path=apps/cli/examples/does-not-exist.json");
		expect(res.status).toBe(404);
		const text = await res.text();
		expect(text).toContain("Could not read manifest");
		expect(text).toContain("does-not-exist.json");
	});

	test("path-traversal escape returns 403", async () => {
		const res = await get("/inspect?path=../../../etc/passwd");
		expect(res.status).toBe(403);
		const text = await res.text();
		expect(text).toContain("Path outside workspace");
	});

	test("absolute path outside the workspace returns 403", async () => {
		const res = await get("/inspect?path=/etc/passwd");
		expect(res.status).toBe(403);
		const text = await res.text();
		expect(text).toContain("Path outside workspace");
	});

	test("valid JSON that is not a chit manifest returns 422", async () => {
		// package.json exists and is valid JSON, but it does not pass
		// parseManifest's schema checks.
		const res = await get("/inspect?path=package.json");
		expect(res.status).toBe(422);
		const text = await res.text();
		expect(text).toContain("Manifest did not parse");
	});

	test("existing file that is not JSON returns 400", async () => {
		// README.md exists but is markdown, not JSON.
		const res = await get("/inspect?path=README.md");
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("not valid JSON");
	});
});
