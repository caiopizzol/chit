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
	| { document: ParsedStudioDocument; graphModel: GraphModel }
	| { document: ErrorStudioDocument };

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

export type Bootstrap =
	| {
			mode: "open";
			docId: string;
			document: ParsedStudioDocument;
			graphModel: GraphModel;
	  }
	| {
			mode: "open";
			docId: string;
			document: ErrorStudioDocument;
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
