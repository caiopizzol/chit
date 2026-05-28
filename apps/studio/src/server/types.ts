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
