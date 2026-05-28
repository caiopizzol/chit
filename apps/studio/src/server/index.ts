// Public server entry. apps/cli imports startStudio from "chit-studio/server"
// at boot. The CLI loads the registry (node-side) and passes it in; this
// module knows nothing about CLI internals.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRegistry, SurfaceKind } from "@chit/core";
import { isKnownSurface } from "@chit/core";
import { Hono } from "hono";
import { bearerAuth, buildHostAllowlist, hostAllowlist } from "./auth.ts";
import { discover } from "./discovery.ts";
import { buildBootstrap, DocStore } from "./docs.ts";
import { renderShell } from "./shell.ts";
import { generateToken } from "./token.ts";

// Client bundle output, relative to this file. Resolved against import.meta
// so the path is correct regardless of the caller's cwd. Built by
// `bun --filter chit-studio build:client`.
const CLIENT_DIST = join(import.meta.dir, "..", "..", "dist", "client");
const CLIENT_ASSETS = new Set(["index.js", "index.css"]);

export { PathError } from "./paths.ts";
export type { Bootstrap, DocumentDetail, StudioDocument } from "./types.ts";

export interface StartStudioOptions {
	cwd: string;
	explicitPath?: string;
	registry: NormalizedRegistry;
	hostname?: string;
	port?: number;
	// Where the React client bundle (index.js, index.css) lives. Defaults to
	// the production location relative to this module. Tests override it to
	// point at a temp dir with controlled contents.
	clientDistDir?: string;
	// Surface the initial GraphModel validates against. Defaults to
	// "claude-skill" because that is the shipped install target and the one
	// most likely to surface real warnings. The client can re-fetch with a
	// different surface via ?surface=<kind>.
	defaultSurface?: SurfaceKind;
}

export interface StudioHandle {
	url: string;
	port: number;
	stop(): void;
}

export async function startStudio(opts: StartStudioOptions): Promise<StudioHandle> {
	const hostname = opts.hostname ?? "127.0.0.1";
	const requestedPort = opts.port ?? 0;

	const discovery = discover({ cwd: opts.cwd, explicitPath: opts.explicitPath });
	const store = new DocStore(opts.cwd, opts.registry);
	const defaultSurface: SurfaceKind = opts.defaultSurface ?? "claude-skill";
	const bootstrap = buildBootstrap(discovery, store, defaultSurface);
	const token = generateToken();

	// The Host allowlist is populated after the server starts and the actual
	// port is known. The middleware closes over the Set so adding entries
	// after `app.use` registration is fine.
	const allowedHosts = new Set<string>();
	const clientDistDir = opts.clientDistDir ?? CLIENT_DIST;
	const app = buildApp({ token, bootstrap, store, allowedHosts, clientDistDir });

	const server = Bun.serve({
		port: requestedPort,
		hostname,
		fetch: app.fetch,
	});

	const actualPort = server.port;
	if (actualPort === undefined) {
		server.stop(true);
		throw new Error("chit studio: Bun.serve did not assign a port");
	}
	for (const host of buildHostAllowlist(actualPort)) {
		allowedHosts.add(host);
	}

	const url = `http://${hostname}:${actualPort}/`;
	return {
		url,
		port: actualPort,
		stop() {
			server.stop(true);
		},
	};
}

interface BuildAppOptions {
	token: string;
	bootstrap: import("./types.ts").Bootstrap;
	store: DocStore;
	allowedHosts: Set<string>;
	clientDistDir: string;
}

// Exported for tests: lets us exercise routes via app.fetch without booting
// a real server.
export function buildApp(opts: BuildAppOptions) {
	const app = new Hono();

	app.use("*", hostAllowlist(opts.allowedHosts));

	app.get("/", (c) => {
		return c.html(renderShell({ token: opts.token, bootstrap: opts.bootstrap }));
	});

	// Static client assets. The set is small and explicit: refusing other
	// names keeps the route from becoming a generic file server.
	app.get("/client/:asset", async (c) => {
		const asset = c.req.param("asset");
		if (!CLIENT_ASSETS.has(asset)) return c.text("not found", 404);
		const path = join(opts.clientDistDir, asset);
		if (!existsSync(path)) {
			return c.text(`client bundle missing at ${path}. Run: bun run studio:build`, 503);
		}
		return new Response(Bun.file(path));
	});

	app.use("/api/*", bearerAuth(opts.token));

	app.get("/api/documents/:docId", (c) => {
		const docId = c.req.param("docId");
		const surfaceQuery = c.req.query("surface");
		let surface: SurfaceKind | undefined;
		if (surfaceQuery !== undefined && surfaceQuery !== "") {
			if (!isKnownSurface(surfaceQuery)) {
				// new Response instead of c.text because Hono's c.text generics
				// resolve narrowly in chit-cli's typecheck context with a
				// templated message + numeric literal status.
				return new Response(`unknown surface "${surfaceQuery}"`, { status: 400 });
			}
			surface = surfaceQuery;
		}
		const detail = opts.store.get(docId, surface);
		if (!detail) return c.text("not found", 404);
		return c.json(detail);
	});

	app.put("/api/documents/:docId", async (c) => {
		const docId = c.req.param("docId");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return new Response("invalid JSON body", { status: 400 });
		}
		if (typeof body !== "object" || body === null || !("draft" in body) || !("baseHash" in body)) {
			return new Response("body must be { draft, surface?, baseHash }", { status: 400 });
		}
		const {
			draft,
			surface: surfaceInput,
			baseHash,
		} = body as {
			draft: unknown;
			surface?: unknown;
			baseHash: unknown;
		};
		if (typeof baseHash !== "string" || baseHash.length === 0) {
			return new Response("baseHash must be a non-empty string", { status: 400 });
		}
		let surface: SurfaceKind | undefined;
		if (surfaceInput !== undefined && surfaceInput !== "") {
			if (typeof surfaceInput !== "string" || !isKnownSurface(surfaceInput)) {
				return new Response(`unknown surface "${String(surfaceInput)}"`, { status: 400 });
			}
			surface = surfaceInput;
		}
		const result = opts.store.save(docId, draft, surface, baseHash);
		if (result.kind === "not-found") return c.text("not found", 404);
		if (result.kind === "conflict") {
			return c.json({ kind: "conflict", currentHash: result.currentHash }, 409);
		}
		// Both "saved" and "parse-error" return a 200 with a SaveResponse-shaped
		// body. The error variant has no graphModel/hash; the client checks
		// document.status to discriminate.
		return c.json(result.response);
	});

	app.post("/api/documents/:docId/preview", async (c) => {
		const docId = c.req.param("docId");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return new Response("invalid JSON body", { status: 400 });
		}
		if (typeof body !== "object" || body === null || !("draft" in body)) {
			return new Response("body must be { draft, surface? }", { status: 400 });
		}
		const { draft, surface: surfaceInput } = body as { draft: unknown; surface?: unknown };
		let surface: SurfaceKind | undefined;
		if (surfaceInput !== undefined && surfaceInput !== "") {
			if (typeof surfaceInput !== "string" || !isKnownSurface(surfaceInput)) {
				return new Response(`unknown surface "${String(surfaceInput)}"`, { status: 400 });
			}
			surface = surfaceInput;
		}
		const result = opts.store.preview(docId, draft, surface);
		if (!result) return c.text("not found", 404);
		return c.json(result);
	});

	return app;
}
