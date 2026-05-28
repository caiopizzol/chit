// Server-side document table. The browser only ever names docIds; absolute
// paths live here, behind the docId map.

import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { NormalizedRegistry, SurfaceKind } from "@chit/core";
import { buildGraphModel, parseManifest } from "@chit/core";
import type { DiscoveryResult } from "./discovery.ts";
import type { Bootstrap, DocumentDetail, PreviewResponse, StudioDocument } from "./types.ts";

// Match the existing apps/cli/examples/*.json formatting: tab-indented,
// key order preserved from the input. Deterministic for the same draft,
// which is what the diff view needs in a later sub-unit.
function canonicalize(draft: unknown): string {
	return JSON.stringify(draft, null, "\t");
}

interface DocEntry {
	absolutePath: string;
	relPath: string;
}

export class DocStore {
	private entries = new Map<string, DocEntry>();

	constructor(
		private cwd: string,
		private registry: NormalizedRegistry,
	) {}

	add(docId: string, absolutePath: string): void {
		const rel = relative(this.cwd, absolutePath);
		const relPath = rel === "" || rel.startsWith("..") ? basename(absolutePath) : rel;
		this.entries.set(docId, { absolutePath, relPath });
	}

	has(docId: string): boolean {
		return this.entries.has(docId);
	}

	// Validate a client-supplied draft (file-shape JSON, not NormalizedManifest)
	// against the same parseManifest + buildGraphModel pipeline the server uses
	// for disk reads. Returns null only if the docId is unknown. Parse failures
	// are returned as the `error` variant so the client can render a useful UI.
	// Does NOT write to disk; the caller is previewing what a save would do.
	preview(docId: string, draft: unknown, surface?: SurfaceKind): PreviewResponse | null {
		const entry = this.entries.get(docId);
		if (!entry) return null;

		try {
			const manifest = parseManifest(draft);
			const graphModel = buildGraphModel(manifest, this.registry, surface);
			const canonicalRaw = canonicalize(draft);
			return {
				document: {
					id: docId,
					relPath: entry.relPath,
					raw: canonicalRaw,
					status: "parsed",
					manifest,
				},
				graphModel,
				canonicalRaw,
			};
		} catch (e) {
			// The error variant's `raw` is what the client sent, serialized in
			// the same canonical style so the UI can show it alongside the
			// parser error.
			const raw = canonicalize(draft);
			const errorDoc: StudioDocument = {
				id: docId,
				relPath: entry.relPath,
				raw,
				status: "error",
				parseError: (e as Error).message,
			};
			return { document: errorDoc };
		}
	}

	// Reads the file, parses, and builds the graph model. Returns null only if
	// the docId is unknown to this store. Parse failures are returned as the
	// `error` variant of StudioDocument so the client can render a useful UI.
	//
	// `surface` controls which surface the GraphModel validates against. When
	// passed, `graphModel.validation` is populated and `graphModel.surface`
	// names the kind. When omitted, `graphModel.validation` is null and the
	// client will get an empty validation panel until a surface is picked.
	get(docId: string, surface?: SurfaceKind): DocumentDetail | null {
		const entry = this.entries.get(docId);
		if (!entry) return null;

		let raw: string;
		try {
			raw = readFileSync(entry.absolutePath, "utf-8");
		} catch (e) {
			const errorDoc: StudioDocument = {
				id: docId,
				relPath: entry.relPath,
				raw: "",
				status: "error",
				parseError: `could not read file: ${(e as Error).message}`,
			};
			return { document: errorDoc };
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw);
		} catch (e) {
			const errorDoc: StudioDocument = {
				id: docId,
				relPath: entry.relPath,
				raw,
				status: "error",
				parseError: `not valid JSON: ${(e as Error).message}`,
			};
			return { document: errorDoc };
		}

		try {
			const manifest = parseManifest(parsedJson);
			const graphModel = buildGraphModel(manifest, this.registry, surface);
			return {
				document: {
					id: docId,
					relPath: entry.relPath,
					raw,
					status: "parsed",
					manifest,
				},
				graphModel,
			};
		} catch (e) {
			const errorDoc: StudioDocument = {
				id: docId,
				relPath: entry.relPath,
				raw,
				status: "error",
				parseError: (e as Error).message,
			};
			return { document: errorDoc };
		}
	}
}

// Build the SSR bootstrap payload from the discovery result. Populates the
// store as a side effect (every doc the bootstrap references must be in the
// store so subsequent /api/documents/:docId requests can find it).
//
// `defaultSurface` is the surface the initial GraphModel validates against.
// When omitted, validation is null at boot and the client picks a surface
// before any validation is populated.
export function buildBootstrap(
	discovery: DiscoveryResult,
	store: DocStore,
	defaultSurface?: SurfaceKind,
): Bootstrap {
	if (discovery.kind === "empty") {
		return { mode: "empty" };
	}
	if (discovery.kind === "open") {
		const docId = "current";
		store.add(docId, discovery.absolutePath);
		const detail = store.get(docId, defaultSurface);
		if (!detail) return { mode: "empty" }; // unreachable: just added it
		// "graphModel" in detail discriminates the DocumentDetail union: the
		// parsed variant carries graphModel, the error variant does not.
		if ("graphModel" in detail) {
			return {
				mode: "open",
				docId,
				document: detail.document,
				graphModel: detail.graphModel,
			};
		}
		return { mode: "open", docId, document: detail.document };
	}
	// picker
	const candidates = discovery.candidates.map((c, i) => {
		const docId = `c${i}`;
		store.add(docId, c.absolutePath);
		const detail = store.get(docId, defaultSurface);
		const status: "parsed" | "error" = detail?.document.status === "parsed" ? "parsed" : "error";
		return { docId, relPath: c.relPath, status };
	});
	return { mode: "picker", candidates };
}
