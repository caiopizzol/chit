// Client state shape. The slice 2 reshape (per docs/studio-v0.md and
// the slice 2 design discussion) replaces `draft: NormalizedManifest`
// with `draftSource: Record<string, unknown>`: the editable file-shape
// JSON, not the derived shape parseManifest produces. NormalizedManifest
// carries derived fields (dependencies, executionOrder, declared/inferred
// requires, step refs) that the user does not edit. The registry stays
// server-side, so the client cannot recompute buildGraphModel locally;
// the server's preview/save endpoints are the validation source.

import type { GraphModel } from "@chit/core";
import type { Bootstrap } from "../server/types.ts";

export interface OpenClientState {
	mode: "open";
	docId: string;
	relPath: string;
	// `raw` is the last server-known file text. At boot, the SSR value;
	// after a successful PUT it updates to canonicalRaw from the response.
	raw: string;
	// `hash` is the sha256 hex of the on-disk bytes the server last
	// confirmed. Carried through edits; sent back as baseHash on PUT for
	// conflict detection. Updates to the new hash returned by a successful
	// save.
	hash: string;
	// `draftSource` is the editable manifest JSON object. At boot it equals
	// JSON.parse(raw). Edits mutate this; preview/save POST it to the server.
	draftSource: Record<string, unknown>;
	// `graphModel` is whatever the server last produced for the current
	// draft + surface combination. At boot it comes from the SSR payload.
	graphModel: GraphModel;
	// `dirty` true when draftSource diverges from `raw`. Slice 2.1 wires
	// real edits; for now it stays false.
	dirty: boolean;
	// `previewPending` true while a preview POST is in flight. Used by the
	// surface selector and (later) edit handlers to disable controls.
	previewPending: boolean;
	// `previewError` carries the last preview failure if any (HTTP or
	// parser error); null on success or when no preview has run yet.
	previewError: string | null;
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
		// draftSource is the file-shape JSON the user will edit. Parsing the
		// boot raw is safe: it just came from the server which already
		// JSON.parsed it for the manifest field.
		let draftSource: Record<string, unknown>;
		try {
			const parsed = JSON.parse(bootstrap.document.raw);
			draftSource =
				typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			draftSource = {};
		}
		return {
			mode: "open",
			docId: bootstrap.docId,
			relPath: bootstrap.document.relPath,
			raw: bootstrap.document.raw,
			hash: bootstrap.hash,
			draftSource,
			graphModel: bootstrap.graphModel,
			dirty: false,
			previewPending: false,
			previewError: null,
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
