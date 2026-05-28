// Two middlewares that gate Studio's HTTP surface together. Both are
// required; either alone leaves a real attack surface.
//
// Host check defends DNS rebinding: the attacker's request still carries
// the attacker-controlled hostname in the Host header, which never matches
// our localhost:<port> allowlist.
//
// Bearer token defends localhost-resident processes that can hit the port
// directly. The token never appears in the URL; it rides Authorization.

import type { Context, MiddlewareHandler } from "hono";
import { tokensEqual } from "./token.ts";

export function hostAllowlist(allowed: ReadonlySet<string>): MiddlewareHandler {
	return async (c: Context, next) => {
		const host = c.req.header("host") ?? "";
		if (!allowed.has(host)) {
			return c.text("forbidden host", 403);
		}
		return next();
	};
}

export function bearerAuth(expectedToken: string): MiddlewareHandler {
	return async (c: Context, next) => {
		const auth = c.req.header("authorization") ?? "";
		if (!auth.startsWith("Bearer ")) {
			return c.text("unauthorized", 401);
		}
		const presented = auth.slice("Bearer ".length);
		if (!tokensEqual(expectedToken, presented)) {
			return c.text("unauthorized", 401);
		}
		return next();
	};
}

export function buildHostAllowlist(port: number): Set<string> {
	return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}
