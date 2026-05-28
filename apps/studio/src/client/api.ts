// Authenticated client → server fetch helpers. Every API call carries the
// Bearer token from sessionStorage. URLs are same-origin (Studio serves both
// the client bundle and the API on one port), so no CORS configuration is
// involved.

import type { DocumentDetail, PreviewResponse } from "../server/types.ts";
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
