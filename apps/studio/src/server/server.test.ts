// End-to-end route tests via app.fetch (no server boot). Covers auth + Host
// allowlist + SSR shell + the one document endpoint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistry } from "@chit/core";
import { buildBootstrap, DocStore } from "./docs.ts";
import { buildApp } from "./index.ts";
import { generateToken } from "./token.ts";

const REGISTRY = parseRegistry(undefined);
const PORT = 4040;
const HOST = `127.0.0.1:${PORT}`;
const ALLOWED = new Set([HOST, `localhost:${PORT}`, `[::1]:${PORT}`]);

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "chit-studio-server-"));
}

function chit(id: string): string {
	return JSON.stringify({
		schema: 1,
		id,
		description: `test chit ${id}`,
		inputs: { q: { type: "string" } },
		requires: {},
		participants: { a: { agent: "claude", role: "r", session: "stateless" } },
		steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
		output: "s",
	});
}

interface Setup {
	cwd: string;
	token: string;
	app: ReturnType<typeof buildApp>;
}

function setup(opts: { clientDistDir?: string } = {}): Setup {
	const cwd = tempCwd();
	const path = join(cwd, "consult.json");
	writeFileSync(path, chit("consult"));
	const store = new DocStore(cwd, REGISTRY);
	const bootstrap = buildBootstrap(
		{ kind: "open", absolutePath: path, relPath: "consult.json" },
		store,
	);
	const token = generateToken();
	const app = buildApp({
		token,
		bootstrap,
		store,
		allowedHosts: ALLOWED,
		clientDistDir: opts.clientDistDir ?? "/this/path/does/not/exist",
	});
	return { cwd, token, app };
}

function teardown(s: Setup) {
	rmSync(s.cwd, { recursive: true, force: true });
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
		try {
			const res = await req(s.app, "/", { host: "attacker.com:80" });
			expect(res.status).toBe(403);
		} finally {
			teardown(s);
		}
	});

	test("rejects missing Host with 403", async () => {
		const s = setup();
		try {
			// Have to construct a Request without the host header surviving;
			// Request always sets host from URL. Use a non-allowlisted host
			// instead, which exercises the same code path.
			const res = await req(s.app, "/", { host: "evil:1234" });
			expect(res.status).toBe(403);
		} finally {
			teardown(s);
		}
	});

	test("accepts 127.0.0.1, localhost, and [::1] on the configured port", async () => {
		const s = setup();
		try {
			for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
				const res = await req(s.app, "/", { host });
				expect(res.status).toBe(200);
			}
		} finally {
			teardown(s);
		}
	});
});

describe("Bearer auth on /api/*", () => {
	test("missing Authorization returns 401", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current");
			expect(res.status).toBe(401);
		} finally {
			teardown(s);
		}
	});

	test("wrong-scheme Authorization returns 401", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current");
			expect(res.status).toBe(401);
			// Basic auth instead of Bearer
			const res2 = await s.app.fetch(
				new Request(`http://${HOST}/api/documents/current`, {
					headers: { host: HOST, authorization: "Basic abc" },
				}),
			);
			expect(res2.status).toBe(401);
		} finally {
			teardown(s);
		}
	});

	test("wrong token returns 401", async () => {
		const s = setup();
		try {
			// Same length as a real token to verify it's not a length-only check.
			const bogus = "a".repeat(s.token.length);
			const res = await req(s.app, "/api/documents/current", { token: bogus });
			expect(res.status).toBe(401);
		} finally {
			teardown(s);
		}
	});

	test("correct token returns 200 with DocumentDetail", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current", { token: s.token });
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				document: { status: string; id: string; relPath: string; absolutePath?: string };
				graphModel?: unknown;
			};
			expect(body.document.status).toBe("parsed");
			expect(body.document.id).toBe("current");
			expect(body.document.relPath).toBe("consult.json");
			expect(body.graphModel).toBeDefined();
			expect(body.document.absolutePath).toBeUndefined();
		} finally {
			teardown(s);
		}
	});

	test("unknown docId with valid token returns 404", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/nope", { token: s.token });
			expect(res.status).toBe(404);
		} finally {
			teardown(s);
		}
	});

	test("GET / does NOT require token (token is in the SSR payload)", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/");
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("window.__chit");
			expect(html).toContain(s.token);
		} finally {
			teardown(s);
		}
	});
});

describe("/client/:asset", () => {
	test("rejects unknown asset names with 404 before any file lookup", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/client/secret.env");
			expect(res.status).toBe(404);
		} finally {
			teardown(s);
		}
	});

	test("returns 503 with a helpful message when the bundle is missing", async () => {
		// setup() defaults clientDistDir to a non-existent path.
		const s = setup();
		try {
			const res = await req(s.app, "/client/index.js");
			expect(res.status).toBe(503);
			const body = await res.text();
			expect(body).toContain("studio:build");
		} finally {
			teardown(s);
		}
	});

	test("returns 200 with the file when the bundle is present", async () => {
		const dist = mkdtempSync(join(tmpdir(), "chit-studio-dist-"));
		writeFileSync(join(dist, "index.js"), 'console.log("hi");');
		const s = setup({ clientDistDir: dist });
		try {
			const res = await req(s.app, "/client/index.js");
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("console.log");
		} finally {
			teardown(s);
			rmSync(dist, { recursive: true, force: true });
		}
	});
});

describe("SSR shell payload escaping", () => {
	test("</script> sequence in payload is escaped so the inline script cannot break out", async () => {
		// Build a payload whose document's description contains "</script>".
		// In normal flow this only happens if the chit's data carries it; we
		// craft it via a custom DocStore add to simulate.
		const cwd = tempCwd();
		try {
			const path = join(cwd, "x.json");
			const raw = JSON.stringify({
				schema: 1,
				id: "x",
				description: "</script><script>alert(1)</script>",
				inputs: { q: { type: "string" } },
				requires: {},
				participants: { a: { agent: "claude", role: "r", session: "stateless" } },
				steps: { s: { call: "a", prompt: "{{ inputs.q }}" } },
				output: "s",
			});
			writeFileSync(path, raw);
			const store = new DocStore(cwd, REGISTRY);
			const bootstrap = buildBootstrap(
				{ kind: "open", absolutePath: path, relPath: "x.json" },
				store,
			);
			const token = generateToken();
			const app = buildApp({
				token,
				bootstrap,
				store,
				allowedHosts: ALLOWED,
				clientDistDir: "/this/path/does/not/exist",
			});
			const res = await req(app, "/");
			const html = await res.text();
			// Raw </script> must NOT appear inside the JSON payload.
			// (It may still appear in the surrounding HTML chrome's
			// closing tag.) Easier check: the escape sequence is present.
			expect(html).toContain("\\u003c/script>");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
