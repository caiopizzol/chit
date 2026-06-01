// Server-side document table. The browser only ever names docIds; absolute
// paths live here, behind the docId map.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { NormalizedRegistry, SurfaceKind } from "@chit-run/core";
import { buildGraphModel, parseManifest } from "@chit-run/core";
import type { DiscoveryResult } from "./discovery.ts";
import type {
	Bootstrap,
	DocumentDetail,
	ErrorSaveResponse,
	PreviewResponse,
	SavedSaveResponse,
	StudioDocument,
} from "./types.ts";

// Match the existing examples/*.json formatting: tab-indented,
// key order preserved from the input. Deterministic for the same draft,
// which is what the diff view needs in a later sub-unit.
function canonicalize(draft: unknown): string {
	return JSON.stringify(draft, null, "\t");
}

// SHA-256 hex of the raw file bytes. Used both as the base-hash the
// client sends back on PUT and as the new hash returned after a write.
// Deterministic for the same content.
export function hashRaw(raw: string): string {
	return createHash("sha256").update(raw, "utf-8").digest("hex");
}

// Result variants for DocStore.save. The 200 path returns a SaveResponse;
// "conflict" maps to HTTP 409; "not-found" maps to HTTP 404 when the
// docId is unknown or the file was deleted from under us.
export type SaveResult =
	| { kind: "saved"; response: SavedSaveResponse }
	| { kind: "parse-error"; response: ErrorSaveResponse }
	| { kind: "conflict"; currentHash: string }
	| { kind: "not-found" };

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

	// The absolute path behind a docId, or null if unknown. Server-side only
	// (never crosses the wire); used by the install route to hand the
	// lifecycle the on-disk manifest path.
	pathOf(docId: string): string | null {
		return this.entries.get(docId)?.absolutePath ?? null;
	}

	// sha256 of the current on-disk bytes for a docId, or null if the docId is
	// unknown or the file cannot be read. The install route compares this to
	// the client's baseHash to refuse installing a drifted file.
	currentHash(docId: string): string | null {
		const entry = this.entries.get(docId);
		if (!entry) return null;
		try {
			return hashRaw(readFileSync(entry.absolutePath, "utf-8"));
		} catch {
			return null;
		}
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
	//
	// `hash` is always the sha256 of the on-disk bytes at the moment of read;
	// the client carries it through edits and sends it back as baseHash on
	// PUT to detect external changes to the file.
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
			return { document: errorDoc, hash: hashRaw("") };
		}

		const hash = hashRaw(raw);

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
			return { document: errorDoc, hash };
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
				hash,
			};
		} catch (e) {
			const errorDoc: StudioDocument = {
				id: docId,
				relPath: entry.relPath,
				raw,
				status: "error",
				parseError: (e as Error).message,
			};
			return { document: errorDoc, hash };
		}
	}

	// Validate a draft, check disk hash against baseHash, and write
	// canonicalRaw to disk if everything matches. Does NOT auto-create
	// files: the entry must already exist in the docId table (i.e., the
	// chit was discovered or opened at boot). External changes since the
	// client's last load surface as conflict.
	save(
		docId: string,
		draft: unknown,
		surface: SurfaceKind | undefined,
		baseHash: string,
	): SaveResult {
		const entry = this.entries.get(docId);
		if (!entry) return { kind: "not-found" };

		// 1. Read current disk state. If the file was deleted out from under
		//    us we treat that as not-found too; the client should re-launch.
		let currentRaw: string;
		try {
			currentRaw = readFileSync(entry.absolutePath, "utf-8");
		} catch {
			return { kind: "not-found" };
		}
		const currentHash = hashRaw(currentRaw);

		// 2. Conflict: someone else (text editor, git checkout, sibling Studio
		//    tab) changed the file since the client loaded it.
		if (currentHash !== baseHash) {
			return { kind: "conflict", currentHash };
		}

		// 3. Validate the draft. Parse failures: return error variant, no write.
		try {
			const manifest = parseManifest(draft);
			const graphModel = buildGraphModel(manifest, this.registry, surface);
			const canonicalRaw = canonicalize(draft);

			// 4. Write. We write the canonical form, not the literal draft
			//    JSON the client sent, so the on-disk file is always
			//    deterministic for a given parsed structure.
			writeFileSync(entry.absolutePath, canonicalRaw, "utf-8");
			const newHash = hashRaw(canonicalRaw);

			return {
				kind: "saved",
				response: {
					document: {
						id: docId,
						relPath: entry.relPath,
						raw: canonicalRaw,
						status: "parsed",
						manifest,
					},
					graphModel,
					canonicalRaw,
					hash: newHash,
				},
			};
		} catch (e) {
			const raw = canonicalize(draft);
			return {
				kind: "parse-error",
				response: {
					document: {
						id: docId,
						relPath: entry.relPath,
						raw,
						status: "error",
						parseError: (e as Error).message,
					},
				},
			};
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
				hash: detail.hash,
			};
		}
		return { mode: "open", docId, document: detail.document, hash: detail.hash };
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
