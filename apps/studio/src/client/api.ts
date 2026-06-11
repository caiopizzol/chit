// Authenticated client → server fetch helpers. Every API call carries the
// Bearer token from sessionStorage. URLs are same-origin (Studio serves both
// the client bundle and the API on one port), so no CORS configuration is
// involved.

import type { EffectiveConfigView, LiveActivity, LiveCancelResult } from "../server/types.ts";
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

const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

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

// Outcome of a cancel attempt. The structured server results (requested /
// already-finished) and a 404 (the run vanished between snapshots) are expected
// control flow, surfaced as outcome variants rather than thrown. A 422
// (non-background source, or a host-side failure) and 501 (no action handler
// injected) become the `error` variant so the UI can show a calm message; only a
// transport failure (network) throws.
export type LiveCancelOutcome =
	| { kind: "requested"; state: "queued" | "running"; signaled: boolean }
	| { kind: "already-finished"; state: string }
	| { kind: "not-found" }
	| { kind: "error"; status: number; error: string };

// Cancel a live run. runId + source come straight from the selected live row.
// Only background rows are cancellable; the server refuses any other source with
// 422 (Studio does not own foreground cancellation), returned here as the `error`
// outcome rather than thrown.
export async function cancelLiveRun(runId: string, source: string): Promise<LiveCancelOutcome> {
	const res = await fetch("/api/live/cancel", {
		method: "POST",
		headers: { ...authHeaders(), "Content-Type": "application/json" },
		body: JSON.stringify({ runId, source }),
	});
	if (res.status === 404) return { kind: "not-found" };
	if (!res.ok) return { kind: "error", status: res.status, error: await res.text() };
	const body = (await res.json()) as LiveCancelResult;
	if (body.status === "requested") {
		return { kind: "requested", state: body.state, signaled: body.signaled };
	}
	if (body.status === "already-finished") {
		return { kind: "already-finished", state: body.state };
	}
	return { kind: "not-found" };
}

// --- Effective config (read-only) ---

// Outcome of a config fetch. 501 (no host-injected config source: a standalone
// Studio) and 422 (a malformed config file the operator should fix) are expected
// control flow the panel renders calmly, not exceptions; only transport/auth
// failures throw.
export type EffectiveConfigOutcome =
	| { kind: "ok"; config: EffectiveConfigView }
	| { kind: "unavailable" }
	| { kind: "error"; status: number; error: string };

// Fetch the effective config for the Studio target repo. The server re-reads
// the config files per request, so each call observes current disk state -- the
// panel fetches on open rather than caching across opens.
export async function fetchEffectiveConfig(): Promise<EffectiveConfigOutcome> {
	const res = await fetch("/api/config", { headers: authHeaders() });
	if (res.status === 501) return { kind: "unavailable" };
	if (res.status === 401) {
		throw new StudioApiError(res.status, `GET /api/config: ${res.status} ${await res.text()}`);
	}
	if (!res.ok) return { kind: "error", status: res.status, error: await res.text() };
	return { kind: "ok", config: (await res.json()) as EffectiveConfigView };
}
