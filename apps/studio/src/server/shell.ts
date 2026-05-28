// SSR app shell. Plain HTML strings, no JSX runtime. The boot payload
// (token + bootstrap) lives inside a <script> tag that the client picks up
// on load. The </script> sequence inside JSON is escaped so the inline
// script cannot be terminated by attacker-controlled string contents.

import type { Bootstrap } from "./types.ts";

function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

export interface ShellPayload {
	token: string;
	bootstrap: Bootstrap;
}

export function renderShell(payload: ShellPayload): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>chit studio</title>
<style>
body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: #F4F2EA; color: #0A0A0A; padding: 32px; }
h1 { font-family: 'Bricolage Grotesque', serif; font-weight: 700; font-size: 28px; margin: 0 0 12px; letter-spacing: -0.02em; }
p { line-height: 1.5; max-width: 620px; }
code { font-family: 'JetBrains Mono', monospace; background: #E0DBC6; padding: 1px 6px; font-size: 13px; }
</style>
</head>
<body>
<h1>chit studio</h1>
<p>Studio is loading. The React client lands in sub-unit 1.1. The SSR boot payload is already wired: open dev tools and inspect <code>window.__chit</code> to see the token + bootstrap object the client will consume.</p>
<script>window.__chit = ${safeJson(payload)};</script>
</body>
</html>`;
}
