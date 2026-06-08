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
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
<link rel="icon" href="data:," />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&amp;family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/client/index.css" />
</head>
<body>
<div id="root"></div>
<script>window.__chit = ${safeJson(payload)};</script>
<script type="module" src="/client/index.js"></script>
</body>
</html>`;
}
