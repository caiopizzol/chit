// Public server entry. apps/cli imports startStudio from "@chit-run/studio/server"
// at boot. The CLI loads the registry (node-side) and passes it in; this
// module knows nothing about CLI internals.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { defaultAuditDir, readAuditRun } from "./audit.ts";
import { bearerAuth, buildHostAllowlist, hostAllowlist } from "./auth.ts";
import { effectiveConfigView } from "./config.ts";
import { declaredRoutinesView } from "./routines.ts";
import { renderShell } from "./shell.ts";
import { generateToken } from "./token.ts";
import type {
	LiveActivity,
	LiveCancelResult,
	StudioConfigSource,
	StudioLiveActions,
	StudioLiveSource,
	StudioRoutineSource,
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

export type {
	BackgroundLiveRow,
	ConfigOriginSource,
	DeclaredRoutine,
	DeclaredRoutinesView,
	EffectiveAgentView,
	EffectiveConfigView,
	EffectiveRecipeView,
	EffectiveRoleView,
	ForegroundLiveRow,
	LiveActivity,
	LiveActivityRow,
	LiveCancelRequest,
	LiveCancelResult,
	LiveEventKind,
	LiveEventView,
	LiveExecutionIdentity,
	LiveParticipant,
	LiveRecipeIdentity,
	RoutineCheck,
	RoutineManifestSummary,
	RoutineParticipant,
	StudioConfigSource,
	StudioLiveActions,
	StudioLiveSource,
	StudioRoutineSource,
} from "./types.ts";

export interface StartStudioOptions {
	cwd: string;
	hostname?: string;
	port?: number;
	// Where the React client bundle (index.js, index.css) lives. Defaults to
	// the production location relative to this module. Tests override it to
	// point at a temp dir with controlled contents.
	clientDistDir?: string;
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
	// Optional host resolver for per-recipe manifest summaries.
	routineSource?: StudioRoutineSource;
}

export interface StudioHandle {
	url: string;
	port: number;
	stop(): void;
}

export async function startStudio(opts: StartStudioOptions): Promise<StudioHandle> {
	const hostname = opts.hostname ?? "127.0.0.1";
	const requestedPort = opts.port ?? 0;

	const token = generateToken();

	// The Host allowlist is populated after the server starts and the actual
	// port is known. The middleware closes over the Set so adding entries
	// after `app.use` registration is fine.
	const allowedHosts = new Set<string>();
	const clientDistDir = opts.clientDistDir ?? CLIENT_DIST;
	const app = buildApp({
		token,
		allowedHosts,
		clientDistDir,
		liveSource: opts.liveSource,
		liveActions: opts.liveActions,
		configSource: opts.configSource,
		routineSource: opts.routineSource,
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
	allowedHosts: Set<string>;
	clientDistDir: string;
	// Audit store base dir (defaults to the local-state dir the CLI writes).
	// Injected in tests; the future receipt/transcript view can read the same
	// audit refs that MCP/CLI already expose.
	auditDir?: string;
	// Live-activity source injected by the host (see StartStudioOptions). GET
	// /api/live reads this; absent means a coherent empty LiveActivity.
	liveSource?: StudioLiveSource;
	// Live actions injected by the host (see StartStudioOptions). POST
	// /api/live/cancel calls this; absent means 501.
	liveActions?: StudioLiveActions;
	// Effective-config reader injected by the host (see StartStudioOptions). GET
	// /api/config calls this per request; absent means 501.
	configSource?: StudioConfigSource;
	routineSource?: StudioRoutineSource;
}

// Exported for tests: lets us exercise routes via app.fetch without booting
// a real server.
export function buildApp(opts: BuildAppOptions) {
	const app = new Hono();

	app.use("*", hostAllowlist(opts.allowedHosts));

	app.get("/", (c) => {
		return c.html(renderShell({ token: opts.token }));
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

	// Read-only routine menu from the effective config. Manifest resolution is
	// best-effort per recipe; config load failure still fails the route.
	app.get("/api/routines", (c) => {
		if (!opts.configSource) {
			return new Response("config view not available", { status: 501 });
		}
		let config: ReturnType<StudioConfigSource["load"]>;
		try {
			config = opts.configSource.load();
		} catch (e) {
			return new Response(`config load failed: ${(e as Error).message}`, { status: 422 });
		}
		const source = opts.routineSource;
		const resolve = source ? (id: string) => source.resolveManifest(config, id) : undefined;
		return c.json(declaredRoutinesView(config, resolve));
	});

	// Audit transcript for one run. The mounted client does not render receipts
	// yet, but this is the intentionally retained API for the tower-native
	// receipt/transcript view: MCP/CLI already expose audit refs, and a selected
	// live run can link to the same local evidence later. ?blobs=1 also returns
	// the referenced prompt/output bodies, keyed by ref.
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

	return app;
}
