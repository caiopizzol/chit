// Public server entry. apps/cli imports startStudio from "@chit-run/studio/server"
// at boot. The CLI loads the registry (node-side) and passes it in; this
// module knows nothing about CLI internals.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRegistry, NormalizedRole, SurfaceKind } from "@chit-run/core";
import { isKnownSurface } from "@chit-run/core";
import { Hono } from "hono";
import { defaultAuditDir, readAuditRun } from "./audit.ts";
import { bearerAuth, buildHostAllowlist, hostAllowlist } from "./auth.ts";
import { discover } from "./discovery.ts";
import { buildBootstrap, DocStore } from "./docs.ts";
import { listLoops, readLoop } from "./loops.ts";
import { renderShell } from "./shell.ts";
import { generateToken } from "./token.ts";
import type { StudioLifecycle } from "./types.ts";

// Client bundle output, relative to this file. Resolved against import.meta
// so the path is correct regardless of the caller's cwd. Built by
// `bun --filter @chit-run/studio build:client`.
const CLIENT_DIST = join(import.meta.dir, "..", "..", "dist", "client");
const CLIENT_ASSETS = new Set(["index.js", "index.css"]);

export { PathError } from "./paths.ts";
export type {
	Bootstrap,
	DocumentDetail,
	InstalledSummary,
	InstallSummary,
	StudioDocument,
	StudioInstallParams,
	StudioLifecycle,
	UninstallSummary,
} from "./types.ts";

export interface StartStudioOptions {
	cwd: string;
	explicitPath?: string;
	registry: NormalizedRegistry;
	// The role library, so previews resolve role references before buildGraphModel.
	// Optional: a host that injects only a registry (older callers, tests) gets none.
	roles?: Record<string, NormalizedRole>;
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
	// Install / list / uninstall, injected by the host (the CLI). Absent means
	// the lifecycle endpoints return 501 (read-only Studio).
	lifecycle?: StudioLifecycle;
	// The loop-log directory, injected by the host (the CLI), which owns the
	// state-dir location scheme. Absent means no loops are listed (a standalone
	// Studio with no host).
	loopsDir?: string;
}

export interface StudioHandle {
	url: string;
	port: number;
	stop(): void;
}

export async function startStudio(opts: StartStudioOptions): Promise<StudioHandle> {
	const hostname = opts.hostname ?? "127.0.0.1";
	const requestedPort = opts.port ?? 0;

	const store = new DocStore(opts.cwd, opts.registry, opts.roles ?? {});
	const defaultSurface: SurfaceKind = opts.defaultSurface ?? "claude-skill";
	const token = generateToken();

	// Bootstrap is regenerated per GET / (not captured once at boot), so a
	// full page reload reflects the current disk state. This is what makes
	// the conflict-recovery "Reload from disk" action honest: after an
	// external change, reloading re-reads the file rather than re-rendering a
	// stale boot snapshot. The token stays stable across reloads.
	const makeBootstrap = () =>
		buildBootstrap(
			discover({ cwd: opts.cwd, explicitPath: opts.explicitPath }),
			store,
			defaultSurface,
		);

	// Seed the docId table once at boot so /api/* routes resolve even if a
	// request arrives before the first GET / (buildBootstrap's store.add is
	// the only thing that registers docId -> absolutePath). GET / calls
	// makeBootstrap again for a fresh disk read.
	makeBootstrap();

	// The Host allowlist is populated after the server starts and the actual
	// port is known. The middleware closes over the Set so adding entries
	// after `app.use` registration is fine.
	const allowedHosts = new Set<string>();
	const clientDistDir = opts.clientDistDir ?? CLIENT_DIST;
	const app = buildApp({
		token,
		cwd: opts.cwd,
		makeBootstrap,
		store,
		allowedHosts,
		clientDistDir,
		lifecycle: opts.lifecycle,
		loopsDir: opts.loopsDir,
	});

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
	// Invocation cwd (used by manifest discovery and the doc store).
	cwd: string;
	makeBootstrap: () => import("./types.ts").Bootstrap;
	store: DocStore;
	allowedHosts: Set<string>;
	clientDistDir: string;
	lifecycle?: StudioLifecycle;
	// Audit store base dir (defaults to the local-state dir the CLI writes).
	// Injected in tests; the loop view's auditRef points into this store.
	auditDir?: string;
	// Loop-log directory injected by the host (see StartStudioOptions). The
	// read-only loop routes read this; absent means no loops are listed.
	loopsDir?: string;
}

// Exported for tests: lets us exercise routes via app.fetch without booting
// a real server.
export function buildApp(opts: BuildAppOptions) {
	const app = new Hono();

	app.use("*", hostAllowlist(opts.allowedHosts));

	app.get("/", (c) => {
		return c.html(renderShell({ token: opts.token, bootstrap: opts.makeBootstrap() }));
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
				// resolve narrowly in @chit-run/cli's typecheck context with a
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

	// Read-only convergence-log routes. The browser sees only the safe-slug
	// loopId; the loop dir is injected by the host (see StartStudioOptions).

	app.get("/api/loops", (c) => {
		return c.json(listLoops(opts.loopsDir));
	});

	app.get("/api/loops/:loopId", (c) => {
		const result = readLoop(opts.loopsDir, c.req.param("loopId"));
		if (result.kind === "not-found") return c.text("not found", 404);
		if (result.kind === "invalid-id") return new Response("invalid loop id", { status: 400 });
		if (result.kind === "invalid-log") {
			return new Response(`invalid loop log: ${result.message}`, { status: 422 });
		}
		return c.json(result.records);
	});

	// Audit transcript for one run. A loop iteration's
	// auditRef (the audit run id) points here. ?blobs=1 also returns the
	// referenced prompt/output bodies, keyed by ref.
	app.get("/api/audit/:runId", (c) => {
		const blobs = c.req.query("blobs") === "1";
		const result = readAuditRun(opts.auditDir ?? defaultAuditDir(), c.req.param("runId"), blobs);
		if (result.kind === "not-found") return c.text("not found", 404);
		if (result.kind === "invalid-id") return new Response("invalid run id", { status: 400 });
		if (result.kind === "invalid-log") {
			return new Response(`invalid audit log: ${result.message}`, { status: 422 });
		}
		return c.json(
			blobs ? { events: result.events, blobs: result.blobs } : { events: result.events },
		);
	});

	// Lifecycle endpoints. Absent lifecycle (read-only Studio) -> 501. The
	// real install/list/uninstall code is injected by the CLI; failures from
	// it (install conflict, unknown install) surface as 422 with the message.

	app.get("/api/installed", (c) => {
		if (!opts.lifecycle) return new Response("lifecycle not available", { status: 501 });
		return c.json(opts.lifecycle.list());
	});

	app.post("/api/install", async (c) => {
		if (!opts.lifecycle) return new Response("lifecycle not available", { status: 501 });
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return new Response("invalid JSON body", { status: 400 });
		}
		if (
			typeof body !== "object" ||
			body === null ||
			!("docId" in body) ||
			!("surface" in body) ||
			!("baseHash" in body)
		) {
			return new Response("body must be { docId, surface, baseHash, force?, overrideName? }", {
				status: 400,
			});
		}
		const { docId, surface, baseHash, force, overrideName, allowUnenforcedPermissions } = body as {
			docId: unknown;
			surface: unknown;
			baseHash: unknown;
			force?: unknown;
			overrideName?: unknown;
			allowUnenforcedPermissions?: unknown;
		};
		if (typeof surface !== "string")
			return new Response("surface must be a string", { status: 400 });
		if (typeof baseHash !== "string" || baseHash.length === 0) {
			return new Response("baseHash must be a non-empty string", { status: 400 });
		}
		const manifestPath = opts.store.pathOf(String(docId));
		if (!manifestPath) return c.text("not found", 404);
		// Refuse to install a file that drifted since the client loaded it
		// (external change / stale tab). Same conflict contract as PUT.
		const currentHash = opts.store.currentHash(String(docId));
		if (currentHash === null) return c.text("not found", 404);
		if (currentHash !== baseHash) {
			return c.json({ kind: "conflict", currentHash }, 409);
		}
		try {
			const summary = opts.lifecycle.install({
				manifestPath,
				surface,
				force: Boolean(force),
				overrideName: typeof overrideName === "string" ? overrideName : undefined,
				allowUnenforcedPermissions: Boolean(allowUnenforcedPermissions),
			});
			return c.json(summary);
		} catch (e) {
			return new Response(`install failed: ${(e as Error).message}`, { status: 422 });
		}
	});

	app.delete("/api/installed/:name", (c) => {
		if (!opts.lifecycle) return new Response("lifecycle not available", { status: 501 });
		const name = c.req.param("name");
		try {
			return c.json(opts.lifecycle.uninstall(name));
		} catch (e) {
			return new Response(`uninstall failed: ${(e as Error).message}`, { status: 422 });
		}
	});

	return app;
}
