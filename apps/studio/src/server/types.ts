// Wire types shared between the server and (eventually) the client. These
// match the contract in notes/studio-v0.md. Kept here for now because the
// server is the only consumer in sub-unit 1.0; the client will import the
// same module from across the workspace once it lands.

import type { GraphModel, LoopStopStatus, NormalizedManifest } from "@chit/core";

export type ParsedStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "parsed";
	manifest: NormalizedManifest;
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

// Read-only convergence-log view (notes/loop-view-v0.md). GET /api/loops returns
// LoopSummary[]; GET /api/loops/:loopId returns LoopRecord[] (the @chit/core
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
