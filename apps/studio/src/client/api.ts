// Authenticated client → server fetch helpers. Every API call carries the
// Bearer token from sessionStorage. URLs are same-origin (Studio serves both
// the client bundle and the API on one port), so no CORS configuration is
// involved.

import type { DocumentDetail } from "../server/types.ts";
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
