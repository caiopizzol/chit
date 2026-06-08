// Wire types shared between the server and (eventually) the client. These
// match the Studio wire contract. Kept here for now because the
// server is the only consumer in sub-unit 1.0; the client will import the
// same module from across the workspace once it lands.

import type { GraphModel, LoopStopStatus, ResolvedManifest } from "@chit-run/core";

export type ParsedStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "parsed";
	// The server resolves every draft (parseManifest -> resolveManifest) before it
	// builds the graph model, so what crosses the wire is a ResolvedManifest, not a
	// bare parse. Typed accordingly so the contract does not under-claim (clients may
	// read participant provenance); resolution errors surface as the `error` variant.
	manifest: ResolvedManifest;
};

export type ErrorStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "error";
	parseError: string;
};

export type StudioDocument = ParsedStudioDocument | ErrorStudioDocument;

export type DocumentDetail =
	| { document: ParsedStudioDocument; graphModel: GraphModel; hash: string }
	| { document: ErrorStudioDocument; hash: string };

// POST /api/documents/:docId/preview. The client sends an editable
// draft (file-shape JSON, not NormalizedManifest); the server validates
// via parseManifest, builds the graph model, and returns what would
// land on disk if the draft were saved. No disk write happens here.
// `canonicalRaw` is the exact bytes the server would write on save:
// JSON.stringify(draft, null, "\t") preserves the example file style.
//
// Same response shape as DocumentDetail for the union variants, plus
// `canonicalRaw` on the parsed variant so a later sub-unit can render
// the diff against the on-disk raw.

export interface PreviewRequest {
	draft: unknown;
	surface?: string;
}

export type PreviewResponse =
	| { document: ParsedStudioDocument; graphModel: GraphModel; canonicalRaw: string }
	| { document: ErrorStudioDocument };

// PUT /api/documents/:docId. The client sends an editable draft plus
// the baseHash it had at load time. The server reads the current
// on-disk hash; if it matches baseHash, the server validates and
// writes canonicalRaw to disk, returning the new hash. If the disk
// hash has drifted (another editor / git checkout / external change),
// the server returns 409 with the current hash so the client can
// resolve. Parse failures on the draft return the error variant with
// no write.

export interface SaveRequest {
	draft: unknown;
	surface?: string;
	baseHash: string;
}

export interface SavedSaveResponse {
	document: ParsedStudioDocument;
	graphModel: GraphModel;
	canonicalRaw: string;
	hash: string;
}

export interface ErrorSaveResponse {
	document: ErrorStudioDocument;
}

export type SaveResponse = SavedSaveResponse | ErrorSaveResponse;

// Sent with HTTP 409 status.
export interface ConflictResponse {
	kind: "conflict";
	currentHash: string;
}

// Install / list / uninstall surface. The actual node-side lifecycle code
// lives in apps/cli (installClaudeSkill, listInstalled, uninstall) and cannot
// be imported here without a workspace cycle, so the CLI injects an
// implementation of StudioLifecycle into startStudio (dependency injection,
// the same way it already injects the registry). Wire shapes below omit
// absolute paths; the client sees names/surfaces/timestamps only.

export interface InstalledSummary {
	name: string; // install folder + SKILL.md name (marker.installName)
	surface: string;
	manifestId: string;
	installedAt: string; // ISO-8601
}

export interface InstallSummary {
	name: string;
	surface: string;
	// Permission gaps that required an override (warnings, not failures).
	enforcementGaps: Array<{ participantId: string; agentId: string; permission: string }>;
}

export interface UninstallSummary {
	name: string;
}

// What the studio server asks the host to install. The host (CLI) fills in
// outputDir / runtimePath defaults; the server passes the resolved manifest
// path (from the docId table) plus the surface and user options.
export interface StudioInstallParams {
	manifestPath: string;
	surface: string;
	force?: boolean;
	overrideName?: string;
	allowUnenforcedPermissions?: boolean;
}

export interface StudioLifecycle {
	list(): InstalledSummary[];
	install(params: StudioInstallParams): InstallSummary;
	uninstall(name: string): UninstallSummary;
}

// POST /api/install request body. docId resolves to the manifest path
// server-side; the manifest must be saved to disk first (install reads the
// file, not the in-memory draft). baseHash is the hash the client last saw;
// the server rejects with 409 if disk has drifted, so a stale tab or an
// external change cannot install a different chit than the user is looking at
// (same conflict philosophy as PUT).
export interface InstallRequest {
	docId: string;
	surface: string;
	baseHash: string;
	force?: boolean;
	overrideName?: string;
	allowUnenforcedPermissions?: boolean;
}

// Read-only convergence-log view. GET /api/loops returns
// LoopSummary[]; GET /api/loops/:loopId returns LoopRecord[] (the @chit-run/core
// type). loopId is the validated, safe-slug file basename.
export interface LoopSummary {
	loopId: string;
	scope: string;
	task: string;
	status: LoopStopStatus | "in-progress";
	iterations: number;
	totalElapsedMs: number | null;
	startedAt: string;
}

// GET /api/live. A compact, read-only snapshot of what is live across Chit right
// now, for the future visual control tower (a session rail plus a selected run's
// detail). The data is produced by the HOST (the CLI), which owns the Chit state
// readers, and injected as a StudioLiveSource -- the same host-injection pattern
// used for lifecycle and loopsDir, so @chit-run/studio never imports CLI
// internals. A standalone Studio with no host returns an empty LiveActivity, not
// an error.
//
// Two sources, kept visibly distinct -- separate arrays AND a `source` tag on
// every row:
//   - foreground: in-flight foreground loop iterations mirrored from the
//     cross-process foreground registry (live, ephemeral; a crashed or idle run
//     drops out).
//   - background: durable background jobs from the JobStore (cross-session;
//     queued/running/terminal, with `stale` derived for a dead worker).
//
// Every row is a GLANCE summary, safe to hand a browser: ids, a bounded
// scope/task one-liner, phase/display, ages derived against the reader's clock,
// agent+adapter participants, a compact statusLine, and a managed worktree path
// only when already safe to expose. A row NEVER carries prompts, model outputs,
// review prose, config/env values, audit blobs, or task text beyond the existing
// bounded one-liner.

// The one safe participant pair the rail/detail shows: which agent ran and via
// which adapter. The full provenance (permissions, config, env keys) is
// deliberately omitted -- it lives in the audit run and the richer status views.
export interface LiveParticipant {
	agentId: string;
	adapter: string;
}

// One in-flight foreground loop iteration mirrored from the cross-process
// registry. `source` is the literal "foreground" so a flattened list stays
// self-describing alongside background rows.
export interface ForegroundLiveRow {
	source: "foreground";
	runId: string;
	scope: string;
	task: string;
	phase: string;
	statusLine: string;
	// A chit-managed worktree path, present only for an isolated run (already safe
	// to expose -- the same path the loop/run views surface).
	worktreePath?: string;
	// Ages derived against the reader's clock (omitted when not derivable).
	elapsedMs?: number;
	phaseElapsedMs?: number;
	lastActivityAgeMs?: number;
	participants?: Record<string, LiveParticipant>;
}

// One durable background job. `display` is the lifecycle state with `stale`
// derived (a running job whose worker is gone or silent), the same legible signal
// the operator status surfaces.
export interface BackgroundLiveRow {
	source: "background";
	runId: string;
	scope: string;
	// Loop-only one-liner; a one-shot background run has no converge task.
	task?: string;
	display: string;
	phase?: string;
	statusLine: string;
	worktreePath?: string;
	elapsedMs?: number;
	phaseElapsedMs?: number;
	lastHeartbeatAgeMs?: number;
	participants?: Record<string, LiveParticipant>;
}

export type LiveActivityRow = ForegroundLiveRow | BackgroundLiveRow;

export interface LiveActivity {
	foreground: ForegroundLiveRow[];
	background: BackgroundLiveRow[];
}

export interface StudioLiveSource {
	live(): LiveActivity;
}

export type Bootstrap =
	| {
			mode: "open";
			docId: string;
			document: ParsedStudioDocument;
			graphModel: GraphModel;
			hash: string;
	  }
	| {
			mode: "open";
			docId: string;
			document: ErrorStudioDocument;
			hash: string;
	  }
	| {
			mode: "picker";
			candidates: Array<{
				docId: string;
				relPath: string;
				status: "parsed" | "error";
			}>;
	  }
	| {
			mode: "empty";
	  };
