// Route tests for the mounted Studio server surface: shell/static assets plus
// the live/config APIs. Audit route details live in its focused test file.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@chit-run/core";
import { buildApp } from "./index.ts";
import { generateToken } from "./token.ts";
import type {
	LiveActivity,
	StudioLiveActions,
	StudioLiveSource,
	StudioRoutineSource,
} from "./types.ts";

const PORT = 4040;
const HOST = `127.0.0.1:${PORT}`;
const ALLOWED = new Set([HOST, `localhost:${PORT}`, `[::1]:${PORT}`]);

function setup(
	opts: {
		clientDistDir?: string;
		liveSource?: StudioLiveSource;
		liveActions?: StudioLiveActions;
		configSource?: { load(): ReturnType<typeof parseConfig> };
		routineSource?: StudioRoutineSource;
	} = {},
) {
	const token = generateToken();
	const app = buildApp({
		token,
		allowedHosts: ALLOWED,
		clientDistDir: opts.clientDistDir ?? "/this/path/does/not/exist",
		liveSource: opts.liveSource,
		liveActions: opts.liveActions,
		configSource: opts.configSource,
		routineSource: opts.routineSource,
	});
	return { token, app };
}

async function req(
	app: ReturnType<typeof buildApp>,
	path: string,
	init: { host?: string; token?: string } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		host: init.host ?? HOST,
	};
	if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
	return app.fetch(new Request(`http://${headers.host}${path}`, { headers }));
}

describe("Host allowlist", () => {
	test("rejects unknown Host with 403 before any route runs", async () => {
		const s = setup();
		const res = await req(s.app, "/", { host: "attacker.com:80" });
		expect(res.status).toBe(403);
	});

	test("accepts local hosts on the configured port", async () => {
		const s = setup();
		for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
			const res = await req(s.app, "/", { host });
			expect(res.status).toBe(200);
		}
	});
});

describe("Shell and static assets", () => {
	test("GET / renders the token-only shell without auth", async () => {
		const s = setup();
		const res = await req(s.app, "/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("window.__chit");
		expect(html).toContain(s.token);
		expect(html).toContain('<script type="module" src="/client/index.js"></script>');
		expect(html).not.toContain("graphModel");
		expect(html).not.toContain("document");
	});

	test("client assets are served only from the explicit asset allowlist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "chit-studio-client-"));
		try {
			writeFileSync(join(dir, "index.js"), "console.log('ok');");
			writeFileSync(join(dir, "index.css"), "body{}");
			const s = setup({ clientDistDir: dir });
			expect((await req(s.app, "/client/index.js")).status).toBe(200);
			expect((await req(s.app, "/client/index.css")).status).toBe(200);
			expect((await req(s.app, "/client/other.js")).status).toBe(404);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing client assets return a setup hint", async () => {
		const s = setup();
		const res = await req(s.app, "/client/index.js");
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("client bundle missing");
	});
});

describe("Bearer auth on /api/*", () => {
	test("missing, wrong-scheme, and wrong-token Authorization return 401", async () => {
		const s = setup();
		expect((await req(s.app, "/api/live")).status).toBe(401);
		const basic = await s.app.fetch(
			new Request(`http://${HOST}/api/live`, {
				headers: { host: HOST, authorization: "Basic abc" },
			}),
		);
		expect(basic.status).toBe(401);
		expect((await req(s.app, "/api/live", { token: "x".repeat(s.token.length) })).status).toBe(401);
	});
});

describe("GET /api/live", () => {
	test("returns an empty snapshot when no live source is injected", async () => {
		const s = setup();
		const res = await req(s.app, "/api/live", { token: s.token });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ foreground: [], background: [] });
	});

	test("returns the injected live source snapshot", async () => {
		const live: LiveActivity = {
			foreground: [
				{
					source: "foreground",
					runId: "fg-1",
					scope: "scope",
					task: "task",
					phase: "implementing",
					statusLine: "iteration 1",
				},
			],
			background: [],
		};
		const s = setup({ liveSource: { live: () => live } });
		const res = await req(s.app, "/api/live", { token: s.token });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(live);
	});

	test("degrades a throwing live source to an empty snapshot", async () => {
		const s = setup({
			liveSource: {
				live: () => {
					throw new Error("state dir unavailable");
				},
			},
		});
		const res = await req(s.app, "/api/live", { token: s.token });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ foreground: [], background: [] });
	});
});

describe("POST /api/live/cancel", () => {
	async function postCancel(
		app: ReturnType<typeof buildApp>,
		token: string,
		body: unknown,
	): Promise<Response> {
		return app.fetch(
			new Request(`http://${HOST}/api/live/cancel`, {
				method: "POST",
				headers: {
					host: HOST,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	}

	test("rejects malformed bodies and unsafe run ids before host actions", async () => {
		const s = setup();
		expect((await postCancel(s.app, s.token, {})).status).toBe(400);
		expect(
			(await postCancel(s.app, s.token, { runId: "../evil", source: "background" })).status,
		).toBe(400);
	});

	test("refuses foreground cancellation honestly", async () => {
		const s = setup();
		const res = await postCancel(s.app, s.token, { runId: "fg-1", source: "foreground" });
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("only background");
	});

	test("returns 501 when no live action handler is injected", async () => {
		const s = setup();
		const res = await postCancel(s.app, s.token, { runId: "bg-1", source: "background" });
		expect(res.status).toBe(501);
	});

	test("maps host action outcomes onto the wire response", async () => {
		const s = setup({
			liveActions: {
				cancelBackground: (runId) =>
					runId === "missing"
						? { status: "not-found" }
						: { status: "requested", state: "running", signaled: true },
			},
		});
		const ok = await postCancel(s.app, s.token, { runId: "bg-1", source: "background" });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ status: "requested", state: "running", signaled: true });
		expect(
			(await postCancel(s.app, s.token, { runId: "missing", source: "background" })).status,
		).toBe(404);
	});
});

describe("GET /api/config", () => {
	test("returns 501 when no host config source is injected", async () => {
		const s = setup();
		const res = await req(s.app, "/api/config", { token: s.token });
		expect(res.status).toBe(501);
	});

	test("returns the redacted effective config view from the injected source", async () => {
		const s = setup({
			configSource: { load: () => parseConfig({ agents: { deep: { adapter: "codex-exec" } } }) },
		});
		const res = await req(s.app, "/api/config", { token: s.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agents: Array<{ id: string }> };
		expect(body.agents.map((a) => a.id)).toContain("deep");
	});

	test("surfaces config load failures as 422", async () => {
		const s = setup({
			configSource: {
				load: () => {
					throw new Error("bad chit.config.json");
				},
			},
		});
		const res = await req(s.app, "/api/config", { token: s.token });
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("bad chit.config.json");
	});
});

describe("GET /api/routines", () => {
	const repoWithRecipe = () =>
		parseConfig({ recipes: { deep: { mode: "converge", manifestPath: "/flows/deep.json" } } });

	test("returns 501 when no host config source is injected", async () => {
		const s = setup();
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(501);
	});

	test("lists the recipe identity (no manifest summary) without a routine source", async () => {
		const s = setup({ configSource: { load: repoWithRecipe } });
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			routines: Array<{ id: string; manifest?: unknown; error?: unknown }>;
		};
		expect(body.routines.map((r) => r.id)).toEqual(["deep"]);
		expect(body.routines[0]).not.toHaveProperty("manifest");
		expect(body.routines[0]).not.toHaveProperty("error");
	});

	test("enriches routines with the injected resolver's manifest summary", async () => {
		const routineSource: StudioRoutineSource = {
			resolveManifest: (_config, id) => ({
				manifestDigest: `sha256:${id}`,
				participants: [
					{ id: "impl", agentId: "claude", session: "per_scope", filesystem: "write" },
				],
				requiredChecks: [{ command: "bun", args: ["test"] }],
			}),
		};
		const s = setup({ configSource: { load: repoWithRecipe }, routineSource });
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			routines: Array<{ id: string; manifest?: { manifestDigest?: string } }>;
		};
		expect(body.routines[0]?.manifest?.manifestDigest).toBe("sha256:deep");
	});

	test("enriches routines with the injected last-run summary", async () => {
		const routineSource: StudioRoutineSource = {
			resolveManifest: (_config, id) => ({
				manifestDigest: `sha256:${id}`,
				participants: [],
				requiredChecks: [],
			}),
			resolveLastRun: (_config, id, manifest) => {
				expect(id).toBe("deep");
				expect(manifest?.manifestDigest).toBe("sha256:deep");
				return {
					status: "converged",
					verdict: "proceed",
					iterationsCompleted: 2,
					elapsedMs: 65_000,
					estimatedCostUsd: 0.05,
					auditRef: "aud-2",
				};
			},
		};
		const s = setup({ configSource: { load: repoWithRecipe }, routineSource });
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			routines: Array<{ lastRun?: { status: string; auditRef?: string } }>;
		};
		expect(body.routines[0]?.lastRun).toMatchObject({
			status: "converged",
			auditRef: "aud-2",
		});
	});

	test("a throwing resolver degrades that routine to a recoverable error, not a 500", async () => {
		const routineSource: StudioRoutineSource = {
			resolveManifest: () => {
				throw new Error("no /flows/deep.json in the git tree at HEAD");
			},
		};
		const s = setup({ configSource: { load: repoWithRecipe }, routineSource });
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { routines: Array<{ error?: string }> };
		expect(body.routines[0]?.error).toContain("git tree at HEAD");
	});

	test("surfaces config load failures as 422", async () => {
		const s = setup({
			configSource: {
				load: () => {
					throw new Error("bad chit.config.json");
				},
			},
		});
		const res = await req(s.app, "/api/routines", { token: s.token });
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("bad chit.config.json");
	});
});
