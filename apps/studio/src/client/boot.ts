// SSR boot consumption. The server inlines the launch token + bootstrap
// payload under window.__chit. This module:
// 1. Reads window.__chit at startup.
// 2. Copies the token into sessionStorage (which survives reloads within
//    the tab but not across tab close — the right lifecycle for a launch
//    token tied to one CLI run).
// 3. Clears window.__chit.token to remove it from the long-lived SSR
//    payload object. After this, sessionStorage is the only app-owned
//    copy. This is NOT an XSS/extension boundary: same-origin script and
//    devtools can still read sessionStorage. The real boundary is the
//    server's defense-in-depth chain (Host allowlist + same-origin app
//    shell + Bearer token + no CORS, per notes/studio-v0.md).
// 4. Returns the bootstrap to the caller.
//
// The runtime path uses real window and sessionStorage. The processing
// logic is split into a pure helper (processBootPayload) so it can be
// tested in node without a DOM.

import type { Bootstrap } from "../server/types.ts";

export const TOKEN_STORAGE_KEY = "chit-studio-token";

declare global {
	interface Window {
		__chit?: { token?: string; bootstrap: Bootstrap };
	}
}

export interface BootInput {
	token: string;
	bootstrap: Bootstrap;
}

export interface TokenStorage {
	setItem(key: string, value: string): void;
	getItem(key: string): string | null;
}

// Pure: store the token, return the bootstrap. Testable without a DOM.
export function processBootPayload(payload: BootInput, storage: TokenStorage): Bootstrap {
	storage.setItem(TOKEN_STORAGE_KEY, payload.token);
	return payload.bootstrap;
}

// Runtime entry. Throws if window.__chit is missing or incomplete; that
// indicates the server failed to inject the SSR payload and there is no
// recovery path the client can take.
export function consumeBoot(): Bootstrap {
	const w = window.__chit;
	if (!w || typeof w.token !== "string" || !w.bootstrap) {
		throw new Error("chit studio: window.__chit missing or incomplete");
	}
	const bootstrap = processBootPayload({ token: w.token, bootstrap: w.bootstrap }, sessionStorage);
	// Remove the token from the SSR payload object. After this,
	// sessionStorage is the only app-owned copy. Same-origin scripts and
	// devtools can still read sessionStorage; the real boundary remains
	// the server's chain (Host allowlist, same-origin app shell, Bearer
	// token, no CORS).
	w.token = undefined;
	return bootstrap;
}

export function getToken(): string {
	const t = sessionStorage.getItem(TOKEN_STORAGE_KEY);
	if (!t) throw new Error("chit studio: token not found in sessionStorage");
	return t;
}
