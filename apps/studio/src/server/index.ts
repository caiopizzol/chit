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
import { effectiveConfigView } from "./config.ts";
import { discover } from "./discovery.ts";
import { buildBootstrap, DocStore } from "./docs.ts";
import { listLoops, readLoop } from "./loops.ts";
import { renderShell } from "./shell.ts";
import { generateToken } from "./token.ts";
import type {
	LiveActivity,
	LiveCancelResult,
	StudioConfigSource,
	StudioLifecycle,
	StudioLiveActions,
	StudioLiveSource,
} from "./types.ts";

// Safe run-id slug for the live action routes, the same shape the loop/audit
// readers enforce: a leading alphanumeric, then word/dash characters only. The id
// becomes a JobStore filesystem key on the host side, so anything else (path
// separators, traversal, dotfiles) is rejected at the route before it leaves
// Studio.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Client bundle output, relative to this file. Resolved against import.meta
// so the path is correct regardless of the caller's cwd. Built by
// `bun --filter @chit-run/studio build:client`.
const CLIENT_DIST = join(import.meta.dir, "..", "..", "dist", "client");
const CLIENT_ASSETS = new Set(["index.js", "index.css"]);

export { PathError } from "./paths.ts";
export type {
	BackgroundLiveRow,
	Bootstrap,
	ConfigOriginSource,
	DocumentDetail,
	EffectiveAgentView,
	EffectiveConfigView,
	EffectiveRecipeView,
	EffectiveRoleView,
	ForegroundLiveRow,
	InstalledSummary,
	InstallSummary,
	LiveActivity,
	LiveActivityRow,
	LiveCancelRequest,
	LiveCancelResult,
	LiveEventKind,
	LiveEventView,
	LiveExecutionIdentity,
	LiveParticipant,
	LiveRecipeIdentity,
	StudioConfigSource,
	StudioDocument,
	StudioInstallParams,
	StudioLifecycle,
	StudioLiveActions,
	StudioLiveSource,
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
	// Live-activity source, injected by the host (the CLI), backed by current Chit
	// state (the foreground registry + background jobs). Absent means GET /api/live
	// returns an empty LiveActivity (a standalone Studio with no host).
	liveSource?: StudioLiveSource;
	// Live actions (cancel a background job), injected by the host (the CLI), which
	// owns JobStore and the worker signaling. Absent means POST /api/live/cancel
	// returns 501 (a read-only / standalone Studio).
	liveActions?: StudioLiveActions;
	// Effective-config reader, injected by the host (the CLI), which owns the
	// file-backed loadConfig. Called per GET /api/config request so the view
	// observes current disk state. Absent means the route returns 501.
	configSource?: StudioConfigSource;
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
		liveSource: opts.liveSource,
		liveActions: opts.liveActions,
		configSource: opts.configSource,
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
	// Live-activity source injected by the host (see StartStudioOptions). GET
	// /api/live reads this; absent means a coherent empty LiveActivity.
	liveSource?: StudioLiveSource;
	// Live actions injected by the host (see StartStudioOptions). POST
	// /api/live/cancel calls this; absent means 501.
	liveActions?: StudioLiveActions;
	// Effective-config reader injected by the host (see StartStudioOptions). GET
	// /api/config calls this per request; absent means 501.
	configSource?: StudioConfigSource;
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

	// Read-only live-activity snapshot for the future control tower. The host
	// (CLI) injects a StudioLiveSource backed by current Chit state (the foreground
	// registry + background jobs). An absent source (standalone Studio with no
	// host) returns a coherent empty LiveActivity, never an error -- the client
	// renders an empty rail rather than handling a failure.
	app.get("/api/live", (c) => {
		const empty: LiveActivity = { foreground: [], background: [] };
		if (!opts.liveSource) {
			return c.json(empty);
		}
		try {
			return c.json(opts.liveSource.live());
		} catch {
			return c.json(empty);
		}
	});

	// Live action: cancel a live run. The mutating counterpart to GET /api/live,
	// injected as StudioLiveActions by the host (the CLI owns JobStore + the worker
	// signaling). Order matters: a malformed body or unsafe run id is a 400; a
	// non-background source is a 422 BEFORE the handler check, so a foreground
	// request is always refused honestly (Studio mirrors foreground snapshots
	// cross-process but does not own the MCP foreground controller, so it cannot
	// cancel one); an absent handler is a 501 (read-only Studio). Only then is the
	// host asked to cancel the background job.
	app.post("/api/live/cancel", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return new Response("invalid JSON body", { status: 400 });
		}
		if (typeof body !== "object" || body === null || !("runId" in body) || !("source" in body)) {
			return new Response("body must be { runId, source }", { status: 400 });
		}
		const { runId, source } = body as { runId: unknown; source: unknown };
		if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
			return new Response("runId must be a safe run-id slug", { status: 400 });
		}
		if (source !== "background") {
			return new Response(
				`cannot cancel source "${String(source)}": only background runs are cancellable from Studio`,
				{ status: 422 },
			);
		}
		if (!opts.liveActions) {
			return new Response("live actions not available", { status: 501 });
		}
		let result: LiveCancelResult;
		try {
			result = opts.liveActions.cancelBackground(runId);
		} catch {
			return new Response("cancel failed", { status: 422 });
		}
		if (result.status === "not-found") return c.text("not found", 404);
		// requested / already-finished are both expected outcomes, not errors: the
		// client renders the status. (The already-finished body lets the rail show
		// "already cancelled/completed" instead of a misleading success.)
		return c.json(result);
	});

	// Read-only effective-config view: which agents and roles Chit would use in
	// the Studio target repo, and which layer defined each. The host re-reads the
	// config files on every load() call, so the response reflects current disk
	// state, never a boot snapshot. Redaction (env keys only, bounded instruction
	// previews) happens in effectiveConfigView before anything crosses the wire.
	// Unlike /api/live, a load failure here is SIGNAL (a malformed config file the
	// operator should fix), so it surfaces as 422 with the loader's message rather
	// than degrading to an empty view that would misreport the effective state.
	app.get("/api/config", (c) => {
		if (!opts.configSource) {
			return new Response("config view not available", { status: 501 });
		}
		try {
			return c.json(effectiveConfigView(opts.configSource.load()));
		} catch (e) {
			return new Response(`config load failed: ${(e as Error).message}`, { status: 422 });
		}
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
