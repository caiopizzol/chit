// Wire types shared between the server and (eventually) the client. These
// match the contract in docs/studio-v0.md. Kept here for now because the
// server is the only consumer in sub-unit 1.0; the client will import the
// same module from across the workspace once it lands.

import type { GraphModel, NormalizedManifest } from "@chit/core";

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
