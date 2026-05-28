// Authenticated client → server fetch helpers. Every API call carries the
// Bearer token from sessionStorage. URLs are same-origin (Studio serves both
// the client bundle and the API on one port), so no CORS configuration is
// involved.

import type {
	ConflictResponse,
	DocumentDetail,
	ErrorSaveResponse,
	PreviewResponse,
	SavedSaveResponse,
} from "../server/types.ts";
import { getToken } from "./boot.ts";

export class StudioApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "StudioApiError";
	}
}

export async function fetchDocument(docId: string, surface: string): Promise<DocumentDetail> {
	const url = `/api/documents/${encodeURIComponent(docId)}?surface=${encodeURIComponent(surface)}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${getToken()}` },
	});
	if (!res.ok) {
		const body = await res.text();
		throw new StudioApiError(res.status, `GET ${url}: ${res.status} ${body}`);
	}
	return (await res.json()) as DocumentDetail;
}

// Server-side validate-and-canonicalize for an in-memory draft. The
// client sends the editable file-shape JSON, not a NormalizedManifest;
// the server runs parseManifest + buildGraphModel and returns what
// would land on disk if saved (no disk write). Used when the surface
// changes (so the draft revalidates against the new surface) and, in
// later sub-units, when the user edits a field and we want a fresh
// graphModel without writing.
export async function previewDocument(
	docId: string,
	draft: unknown,
	surface: string,
): Promise<PreviewResponse> {
	const url = `/api/documents/${encodeURIComponent(docId)}/preview`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ draft, surface }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new StudioApiError(res.status, `POST ${url}: ${res.status} ${body}`);
	}
	return (await res.json()) as PreviewResponse;
}

// Outcome of a save attempt. 409 (conflict) and the parse-error variant are
// expected control-flow, not exceptions; only transport/auth failures throw.
export type SaveOutcome =
	| { kind: "saved"; response: SavedSaveResponse }
	| { kind: "parse-error"; response: ErrorSaveResponse }
	| { kind: "conflict"; currentHash: string };

// PUT the draft with the baseHash the client last saw. The server writes
// canonicalRaw if baseHash still matches disk; otherwise it returns 409 with
// the current disk hash so the client can prompt a reload.
export async function saveDocument(
	docId: string,
	draft: unknown,
	surface: string,
	baseHash: string,
): Promise<SaveOutcome> {
	const url = `/api/documents/${encodeURIComponent(docId)}`;
	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${getToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ draft, surface, baseHash }),
	});
	if (res.status === 409) {
		const body = (await res.json()) as ConflictResponse;
		return { kind: "conflict", currentHash: body.currentHash };
	}
	if (!res.ok) {
		const body = await res.text();
		throw new StudioApiError(res.status, `PUT ${url}: ${res.status} ${body}`);
	}
	const body = (await res.json()) as SavedSaveResponse | ErrorSaveResponse;
	if (body.document.status === "parsed") {
		return { kind: "saved", response: body as SavedSaveResponse };
	}
	return { kind: "parse-error", response: body as ErrorSaveResponse };
}
