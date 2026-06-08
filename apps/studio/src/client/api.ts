// Authenticated client → server fetch helpers. Every API call carries the
// Bearer token from sessionStorage. URLs are same-origin (Studio serves both
// the client bundle and the API on one port), so no CORS configuration is
// involved.

import type { AuditEvent, LoopRecord } from "@chit-run/core";
import type {
	ConflictResponse,
	DocumentDetail,
	ErrorSaveResponse,
	InstalledSummary,
	InstallSummary,
	LiveActivity,
	LoopSummary,
	PreviewResponse,
	SavedSaveResponse,
	UninstallSummary,
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

// --- Lifecycle (install / list / uninstall) ---

const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

export async function listInstalled(): Promise<InstalledSummary[]> {
	const res = await fetch("/api/installed", { headers: authHeaders() });
	if (!res.ok) {
		throw new StudioApiError(res.status, `GET /api/installed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as InstalledSummary[];
}

// Outcome of an install attempt. 409 (the file drifted from baseHash) and the
// 422 install failure are expected control flow, not exceptions; only
// transport/auth failures throw.
export type InstallOutcome =
	| { kind: "installed"; summary: InstallSummary }
	| { kind: "conflict"; currentHash: string }
	| { kind: "error"; error: string };

// Install is always into the Claude Code skill surface for now (the only
// installable target); the validation-surface picker does not drive this.
export async function installDocument(
	docId: string,
	baseHash: string,
	opts: { force?: boolean; overrideName?: string; allowUnenforcedPermissions?: boolean } = {},
): Promise<InstallOutcome> {
	const res = await fetch("/api/install", {
		method: "POST",
		headers: { ...authHeaders(), "Content-Type": "application/json" },
		body: JSON.stringify({ docId, surface: "claude-skill", baseHash, ...opts }),
	});
	if (res.status === 409) {
		const body = (await res.json()) as ConflictResponse;
		return { kind: "conflict", currentHash: body.currentHash };
	}
	if (!res.ok) {
		return { kind: "error", error: await res.text() };
	}
	return { kind: "installed", summary: (await res.json()) as InstallSummary };
}

export async function uninstallDocument(name: string): Promise<UninstallSummary> {
	const res = await fetch(`/api/installed/${encodeURIComponent(name)}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!res.ok) {
		throw new StudioApiError(
			res.status,
			`DELETE /api/installed: ${res.status} ${await res.text()}`,
		);
	}
	return (await res.json()) as UninstallSummary;
}

// --- Convergence log (read-only) ---

// List loop summaries. The server reads the loop dir the host injected (chit's
// state dir, keyed by repo); the client never touches the filesystem or parses
// JSONL.
export async function fetchLoops(): Promise<LoopSummary[]> {
	const res = await fetch("/api/loops", { headers: authHeaders() });
	if (!res.ok) {
		throw new StudioApiError(res.status, `GET /api/loops: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as LoopSummary[];
}

// Fetch one loop's records by its safe-slug id. The id is the only thing the
// browser sends; the server resolves the path.
export async function fetchLoop(loopId: string): Promise<LoopRecord[]> {
	const url = `/api/loops/${encodeURIComponent(loopId)}`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		throw new StudioApiError(res.status, `GET ${url}: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as LoopRecord[];
}

// --- Live activity (read-only) ---

// Snapshot of what is alive across Chit right now (foreground iterations +
// background jobs). The host injects the reader; a standalone Studio with no
// host returns an empty LiveActivity (not an error), and a throwing reader
// degrades to empty server-side, so this only throws on transport/auth.
export async function fetchLive(): Promise<LiveActivity> {
	const res = await fetch("/api/live", { headers: authHeaders() });
	if (!res.ok) {
		throw new StudioApiError(res.status, `GET /api/live: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as LiveActivity;
}

// --- Audit transcript (read-only) ---

export interface AuditRunResponse {
	events: AuditEvent[];
	// Present when fetched with blobs: prompt/output bodies keyed by sha256 ref.
	blobs?: Record<string, string>;
}

// Fetch one audit run's events (and, with blobs, the referenced bodies). The
// runId is the only thing the browser sends; the server resolves the path and
// reads blobs only by refs present in the validated events.
export async function fetchAuditRun(runId: string, blobs: boolean): Promise<AuditRunResponse> {
	const url = `/api/audit/${encodeURIComponent(runId)}${blobs ? "?blobs=1" : ""}`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		throw new StudioApiError(res.status, `GET ${url}: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as AuditRunResponse;
}
