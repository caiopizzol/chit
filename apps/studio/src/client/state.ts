// Client state shape locked by docs/studio-v0.md: `{ raw, draft, graphModel }`
// from day one. In sub-unit 1.2 the draft is immutable (read-only inspector)
// and graphModel is the snapshot from the bootstrap. In sub-unit 2 (slice 2)
// draft becomes the edit target and graphModel is recomputed by re-running
// buildGraphModel(draft, registry) on the client. Setting up the shape now
// means slice 2 only adds setters; no rewrite.

import type { GraphModel, NormalizedManifest } from "@chit/core";
import type { Bootstrap } from "../server/types.ts";

export interface OpenClientState {
	mode: "open";
	docId: string;
	relPath: string;
	raw: string;
	draft: NormalizedManifest;
	graphModel: GraphModel;
}

export interface OpenErrorClientState {
	mode: "open-error";
	docId: string;
	relPath: string;
	raw: string;
	parseError: string;
}

export interface PickerClientState {
	mode: "picker";
	candidates: Array<{ docId: string; relPath: string; status: "parsed" | "error" }>;
}

export interface EmptyClientState {
	mode: "empty";
}

export type ClientState =
	| OpenClientState
	| OpenErrorClientState
	| PickerClientState
	| EmptyClientState;

export function initClientState(bootstrap: Bootstrap): ClientState {
	if (bootstrap.mode === "empty") return { mode: "empty" };
	if (bootstrap.mode === "picker") {
		return { mode: "picker", candidates: bootstrap.candidates };
	}
	// bootstrap.mode === "open"; two sub-variants distinguished by document.status
	if (bootstrap.document.status === "parsed" && "graphModel" in bootstrap) {
		return {
			mode: "open",
			docId: bootstrap.docId,
			relPath: bootstrap.document.relPath,
			raw: bootstrap.document.raw,
			draft: bootstrap.document.manifest,
			graphModel: bootstrap.graphModel,
		};
	}
	// open + error
	return {
		mode: "open-error",
		docId: bootstrap.docId,
		relPath: bootstrap.document.relPath,
		raw: bootstrap.document.raw,
		parseError:
			bootstrap.document.status === "error" ? bootstrap.document.parseError : "unknown parse error",
	};
}
