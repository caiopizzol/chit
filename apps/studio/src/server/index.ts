// Public server entry. apps/cli imports startStudio from "chit-studio/server"
// at boot. The CLI loads the registry (node-side) and passes it in; this
// module knows nothing about CLI internals.

import type { NormalizedRegistry } from "@chit/core";
import { Hono } from "hono";
import { bearerAuth, buildHostAllowlist, hostAllowlist } from "./auth.ts";
import { discover } from "./discovery.ts";
import { buildBootstrap, DocStore } from "./docs.ts";
import { renderShell } from "./shell.ts";
import { generateToken } from "./token.ts";

export { PathError } from "./paths.ts";
export type { Bootstrap, DocumentDetail, StudioDocument } from "./types.ts";

export interface StartStudioOptions {
	cwd: string;
	explicitPath?: string;
	registry: NormalizedRegistry;
	hostname?: string;
	port?: number;
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
	const bootstrap = buildBootstrap(discovery, store);
	const token = generateToken();

	// The Host allowlist is populated after the server starts and the actual
	// port is known. The middleware closes over the Set so adding entries
	// after `app.use` registration is fine.
	const allowedHosts = new Set<string>();
	const app = buildApp({ token, bootstrap, store, allowedHosts });

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
}

// Exported for tests: lets us exercise routes via app.fetch without booting
// a real server.
export function buildApp(opts: BuildAppOptions) {
	const app = new Hono();

	app.use("*", hostAllowlist(opts.allowedHosts));

	app.get("/", (c) => {
		return c.html(renderShell({ token: opts.token, bootstrap: opts.bootstrap }));
	});

	app.use("/api/*", bearerAuth(opts.token));

	app.get("/api/documents/:docId", (c) => {
		const docId = c.req.param("docId");
		const detail = opts.store.get(docId);
		if (!detail) return c.text("not found", 404);
		return c.json(detail);
	});

	return app;
}
