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
	path: string;
	token: string;
	app: ReturnType<typeof buildApp>;
}

function setup(opts: { clientDistDir?: string } = {}): Setup {
	const cwd = tempCwd();
	const path = join(cwd, "consult.json");
	writeFileSync(path, chit("consult"));
	const store = new DocStore(cwd, REGISTRY);
	// Regenerate per call so GET / reflects current disk (matches startStudio).
	const makeBootstrap = () =>
		buildBootstrap({ kind: "open", absolutePath: path, relPath: "consult.json" }, store);
	makeBootstrap(); // seed the docId table, as startStudio does at boot
	const token = generateToken();
	const app = buildApp({
		token,
		makeBootstrap,
		store,
		allowedHosts: ALLOWED,
		clientDistDir: opts.clientDistDir ?? "/this/path/does/not/exist",
	});
	return { cwd, path, token, app };
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

	test("GET ?surface=claude-skill returns DocumentDetail with validation populated", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current?surface=claude-skill", {
				token: s.token,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				graphModel?: { surface?: { kind: string } | null; validation: unknown };
			};
			expect(body.graphModel?.surface?.kind).toBe("claude-skill");
			expect(body.graphModel?.validation).not.toBeNull();
		} finally {
			teardown(s);
		}
	});

	test("GET ?surface=cli also returns validation populated", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current?surface=cli", { token: s.token });
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				graphModel?: { surface?: { kind: string } | null; validation: unknown };
			};
			expect(body.graphModel?.surface?.kind).toBe("cli");
			expect(body.graphModel?.validation).not.toBeNull();
		} finally {
			teardown(s);
		}
	});

	test("GET with unknown ?surface returns 400 before any document work", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current?surface=mcp", { token: s.token });
			expect(res.status).toBe(400);
			const body = await res.text();
			expect(body).toContain("mcp");
		} finally {
			teardown(s);
		}
	});

	test("GET without ?surface returns validation null (matches setup default)", async () => {
		const s = setup();
		try {
			const res = await req(s.app, "/api/documents/current", { token: s.token });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { graphModel?: { validation: unknown } };
			expect(body.graphModel?.validation).toBeNull();
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

	test("GET / regenerates the bootstrap from disk (reload reflects external changes)", async () => {
		const s = setup();
		try {
			const first = await (await req(s.app, "/")).text();
			expect(first).toContain("consult");
			// Change the file on disk, then reload: the SSR payload must reflect
			// the new content, not a boot-time snapshot. The token must not change.
			writeFileSync(s.path, chit("consult-changed-on-disk"));
			const second = await (await req(s.app, "/")).text();
			expect(second).toContain("consult-changed-on-disk");
			expect(second).toContain(s.token);
		} finally {
			teardown(s);
		}
	});
});

describe("PUT /api/documents/:docId", () => {
	async function putReq(
		app: ReturnType<typeof buildApp>,
		path: string,
		body: unknown,
		token: string,
	): Promise<Response> {
		return app.fetch(
			new Request(`http://${HOST}${path}`, {
				method: "PUT",
				headers: {
					host: HOST,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	}

	test("happy path: writes + returns new hash + canonicalRaw + graphModel", async () => {
		const s = setup();
		try {
			// Read the initial disk hash via GET.
			const getRes = await req(s.app, "/api/documents/current?surface=claude-skill", {
				token: s.token,
			});
			const getBody = (await getRes.json()) as { hash: string };
			const baseHash = getBody.hash;
			// Edit + PUT.
			const draft = JSON.parse(chit("consult"));
			draft.description = "edited via PUT";
			const res = await putReq(
				s.app,
				"/api/documents/current",
				{ draft, surface: "claude-skill", baseHash },
				s.token,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				document: { status: string };
				graphModel?: unknown;
				canonicalRaw?: string;
				hash?: string;
			};
			expect(body.document.status).toBe("parsed");
			expect(body.graphModel).toBeDefined();
			expect(body.canonicalRaw).toContain("edited via PUT");
			expect(body.hash).toBeDefined();
			expect(body.hash).not.toBe(baseHash);
		} finally {
			teardown(s);
		}
	});

	test("conflict: 409 with currentHash when baseHash does not match disk", async () => {
		const s = setup();
		try {
			const res = await putReq(
				s.app,
				"/api/documents/current",
				{
					draft: JSON.parse(chit("consult")),
					surface: "claude-skill",
					baseHash: "deadbeef".repeat(8),
				},
				s.token,
			);
			expect(res.status).toBe(409);
			const body = (await res.json()) as { kind: string; currentHash: string };
			expect(body.kind).toBe("conflict");
			expect(body.currentHash).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			teardown(s);
		}
	});

	test("parse error: 200 with error document, no write", async () => {
		const s = setup();
		try {
			const getRes = await req(s.app, "/api/documents/current", { token: s.token });
			const getBody = (await getRes.json()) as { hash: string };
			const baseHash = getBody.hash;
			const res = await putReq(
				s.app,
				"/api/documents/current",
				{ draft: { schema: 1, id: "x" }, surface: "claude-skill", baseHash },
				s.token,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { document: { status: string }; hash?: string };
			expect(body.document.status).toBe("error");
			expect(body.hash).toBeUndefined();
			// Verify disk hash unchanged by re-fetching.
			const after = await req(s.app, "/api/documents/current", { token: s.token });
			const afterBody = (await after.json()) as { hash: string };
			expect(afterBody.hash).toBe(baseHash);
		} finally {
			teardown(s);
		}
	});

	test("unknown surface: 400 before any save work", async () => {
		const s = setup();
		try {
			const res = await putReq(
				s.app,
				"/api/documents/current",
				{ draft: {}, surface: "mcp", baseHash: "x".repeat(64) },
				s.token,
			);
			expect(res.status).toBe(400);
		} finally {
			teardown(s);
		}
	});

	test("missing baseHash: 400", async () => {
		const s = setup();
		try {
			const res = await putReq(
				s.app,
				"/api/documents/current",
				{ draft: {}, surface: "claude-skill" },
				s.token,
			);
			expect(res.status).toBe(400);
		} finally {
			teardown(s);
		}
	});

	test("unknown docId: 404", async () => {
		const s = setup();
		try {
			const res = await putReq(
				s.app,
				"/api/documents/nope",
				{ draft: {}, surface: "claude-skill", baseHash: "x".repeat(64) },
				s.token,
			);
			expect(res.status).toBe(404);
		} finally {
			teardown(s);
		}
	});

	test("missing token: 401", async () => {
		const s = setup();
		try {
			const res = await s.app.fetch(
				new Request(`http://${HOST}/api/documents/current`, {
					method: "PUT",
					headers: { host: HOST, "content-type": "application/json" },
					body: JSON.stringify({ draft: {}, baseHash: "x".repeat(64) }),
				}),
			);
			expect(res.status).toBe(401);
		} finally {
			teardown(s);
		}
	});
});

describe("POST /api/documents/:docId/preview", () => {
	async function jsonReq(
		app: ReturnType<typeof buildApp>,
		path: string,
		body: unknown,
		token: string,
	): Promise<Response> {
		return app.fetch(
			new Request(`http://${HOST}${path}`, {
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

	test("valid draft returns parsed + graphModel + canonicalRaw", async () => {
		const s = setup();
		try {
			const draft = JSON.parse(chit("consult"));
			const res = await jsonReq(
				s.app,
				"/api/documents/current/preview",
				{ draft, surface: "claude-skill" },
				s.token,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				document: { status: string; relPath: string };
				graphModel?: { surface?: { kind: string } | null; validation: unknown };
				canonicalRaw?: string;
			};
			expect(body.document.status).toBe("parsed");
			expect(body.document.relPath).toBe("consult.json");
			expect(body.graphModel?.surface?.kind).toBe("claude-skill");
			expect(body.graphModel?.validation).not.toBeNull();
			expect(body.canonicalRaw).toBeDefined();
			// Tab-indented and roundtrippable.
			expect(body.canonicalRaw).toContain("\t");
			expect(JSON.parse(body.canonicalRaw as string)).toEqual(draft);
		} finally {
			teardown(s);
		}
	});

	test("invalid draft returns error document, no graphModel, no canonicalRaw", async () => {
		const s = setup();
		try {
			const draft = { schema: 1, id: "x" }; // missing required fields
			const res = await jsonReq(
				s.app,
				"/api/documents/current/preview",
				{ draft, surface: "claude-skill" },
				s.token,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				document: { status: string; parseError?: string };
				graphModel?: unknown;
				canonicalRaw?: string;
			};
			expect(body.document.status).toBe("error");
			expect(body.document.parseError).toBeDefined();
			expect(body.graphModel).toBeUndefined();
			expect(body.canonicalRaw).toBeUndefined();
		} finally {
			teardown(s);
		}
	});

	test("unknown docId returns 404", async () => {
		const s = setup();
		try {
			const res = await jsonReq(
				s.app,
				"/api/documents/nope/preview",
				{ draft: {}, surface: "claude-skill" },
				s.token,
			);
			expect(res.status).toBe(404);
		} finally {
			teardown(s);
		}
	});

	test("unknown surface returns 400 before any preview work", async () => {
		const s = setup();
		try {
			const res = await jsonReq(
				s.app,
				"/api/documents/current/preview",
				{ draft: JSON.parse(chit("consult")), surface: "mcp" },
				s.token,
			);
			expect(res.status).toBe(400);
		} finally {
			teardown(s);
		}
	});

	test("missing token returns 401", async () => {
		const s = setup();
		try {
			const res = await s.app.fetch(
				new Request(`http://${HOST}/api/documents/current/preview`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json" },
					body: JSON.stringify({ draft: {} }),
				}),
			);
			expect(res.status).toBe(401);
		} finally {
			teardown(s);
		}
	});

	test("malformed JSON body returns 400", async () => {
		const s = setup();
		try {
			const res = await s.app.fetch(
				new Request(`http://${HOST}/api/documents/current/preview`, {
					method: "POST",
					headers: {
						host: HOST,
						authorization: `Bearer ${s.token}`,
						"content-type": "application/json",
					},
					body: "{not valid",
				}),
			);
			expect(res.status).toBe(400);
		} finally {
			teardown(s);
		}
	});

	test("missing draft key in body returns 400", async () => {
		const s = setup();
		try {
			const res = await jsonReq(
				s.app,
				"/api/documents/current/preview",
				{ surface: "claude-skill" },
				s.token,
			);
			expect(res.status).toBe(400);
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
			const makeBootstrap = () =>
				buildBootstrap({ kind: "open", absolutePath: path, relPath: "x.json" }, store);
			const token = generateToken();
			const app = buildApp({
				token,
				makeBootstrap,
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
