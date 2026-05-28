// Inline CSS for the landing page. Mirrors the H3 mockup (minimal mono palette,
// no accent color, paper + ink, shape-coded status). Sub-section headings use
// mono uppercase per the brand voice "document tone".

export const styles = `
:root {
	--bg: #F4F2EA;
	--sheet: #EAE5D5;
	--receipt: #E0DBC6;
	--ink: #0A0A0A;
	--carbon: #2A2A2A;
	--faded: #807766;
	--pass: #2F6B3E;
	--warn: #9C5B0A;
	--fail: #7B1F15;
	--hairline: #C7BFAB;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	background: var(--bg);
	color: var(--ink);
	font-family: 'Inter', system-ui, sans-serif;
	font-size: 15px;
	line-height: 1.6;
	-webkit-font-smoothing: antialiased;
}
.container { max-width: 720px; margin: 0 auto; padding: 56px 32px; }

nav {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 18px 32px;
	border-bottom: 1px solid var(--ink);
	background: var(--bg);
	max-width: 720px;
	margin: 0 auto;
}
.wordmark {
	font-family: 'Bricolage Grotesque', serif;
	font-weight: 700;
	font-size: 20px;
	letter-spacing: -0.015em;
}
nav .right a {
	color: var(--ink);
	text-decoration: none;
	margin-left: 22px;
	font-size: 12px;
	font-family: 'JetBrains Mono', monospace;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}
nav .right a:hover { text-decoration: underline; }

.signature {
	display: inline-flex;
	align-items: center;
	gap: 10px;
	font-family: 'JetBrains Mono', monospace;
	font-size: 10px;
	color: var(--carbon);
	letter-spacing: 0.14em;
	text-transform: uppercase;
	padding: 6px 12px;
	border: 1px solid var(--ink);
	background: var(--sheet);
	margin: 0 0 40px;
}
.signature .dot {
	width: 7px; height: 7px;
	background: var(--ink);
	border-radius: 50%;
}
.signature .v { color: var(--ink); letter-spacing: 0.04em; text-transform: none; }

h1 {
	font-family: 'Bricolage Grotesque', serif;
	font-weight: 700;
	font-size: 60px;
	line-height: 1.02;
	letter-spacing: -0.035em;
	margin: 0 0 20px;
}
h2 {
	font-family: 'Bricolage Grotesque', serif;
	font-weight: 600;
	font-size: 32px;
	line-height: 1.12;
	letter-spacing: -0.02em;
	margin: 64px 0 12px;
}
h3 {
	font-family: 'JetBrains Mono', monospace;
	font-weight: 700;
	font-size: 13px;
	letter-spacing: 0.16em;
	text-transform: uppercase;
	margin: 48px 0 12px;
	color: var(--ink);
}
p { margin: 0 0 16px; }
.subhead {
	font-size: 18px;
	color: var(--carbon);
	margin-bottom: 28px;
	line-height: 1.5;
}
.lede {
	font-size: 15.5px;
	color: var(--carbon);
	line-height: 1.6;
}

.cta {
	display: inline-block;
	background: var(--ink);
	color: var(--bg);
	padding: 12px 22px;
	text-decoration: none;
	font-weight: 500;
	font-size: 13px;
	margin: 4px 0 0;
	font-family: 'JetBrains Mono', monospace;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}
.cta:hover { background: var(--carbon); }

pre {
	background: var(--receipt);
	border: none;
	border-left: 3px solid var(--ink);
	padding: 16px 20px;
	overflow-x: auto;
	font-family: 'JetBrains Mono', monospace;
	font-size: 12.5px;
	line-height: 1.6;
	color: var(--ink);
	margin: 16px 0 0;
}
pre.terminal {
	background: var(--ink);
	color: #F4F1E8;
	border-left: 3px solid #F4F1E8;
}
pre .cmd { color: var(--ink); font-weight: 700; }
pre.terminal .cmd { color: #F4F1E8; font-weight: 700; }
pre .warn-line { color: var(--warn); }
pre.terminal .warn-line { color: #E2A100; }
pre .pass-line { color: var(--pass); font-weight: 500; }
pre.terminal .pass-line { color: #6CC885; }
pre .meta { color: var(--faded); }
pre.terminal .meta { color: #8C8C8C; }
pre .key { color: var(--ink); font-weight: 600; }
pre .str { color: var(--carbon); }

.keystone {
	text-align: center;
	margin: 96px 0;
	padding: 56px 0;
	border-top: 1px solid var(--ink);
	border-bottom: 1px solid var(--ink);
}
.keystone h2 {
	font-family: 'Bricolage Grotesque', serif;
	font-weight: 700;
	font-size: 88px;
	line-height: 0.98;
	letter-spacing: -0.05em;
	margin: 0;
	color: var(--ink);
}
.keystone .vs {
	color: var(--ink);
	text-decoration: underline;
	text-decoration-thickness: 4px;
	text-underline-offset: 8px;
}
.keystone p {
	font-size: 15px;
	color: var(--carbon);
	margin: 24px auto 0;
	max-width: 380px;
	line-height: 1.5;
}

.receipt-block {
	border-top: 1px solid var(--ink);
	margin: 16px 0 0;
}
.receipt-line {
	display: grid;
	grid-template-columns: 24px 90px 1fr;
	gap: 12px;
	padding: 14px 0;
	border-bottom: 1px dashed var(--ink);
	font-family: 'JetBrains Mono', monospace;
	font-size: 13px;
	align-items: baseline;
}
.receipt-line .ind { width: 8px; height: 8px; margin-top: 6px; }
.receipt-line.pass .ind { background: var(--ink); border-radius: 50%; }
.receipt-line.warn .ind {
	background: transparent;
	border: 2px solid var(--ink);
	width: 6px; height: 6px;
	margin-top: 6px;
}
.receipt-line.fail .ind {
	background: var(--ink);
	transform: rotate(45deg);
	margin-left: 1px;
}
.receipt-line .label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; font-size: 11px; color: var(--ink); }
.receipt-line .body { color: var(--ink); font-family: 'Inter', sans-serif; }

.graph {
	background: var(--sheet);
	border: 1px solid var(--ink);
	padding: 20px;
	margin: 16px 0 0;
}

blockquote {
	border-left: none;
	margin: 64px 0 32px;
	padding: 0;
	font-family: 'Bricolage Grotesque', serif;
	font-size: 32px;
	line-height: 1.2;
	color: var(--ink);
	font-weight: 700;
	text-align: center;
	letter-spacing: -0.025em;
}
blockquote cite {
	display: block;
	font-family: 'JetBrains Mono', monospace;
	font-size: 10px;
	font-weight: 400;
	font-style: normal;
	color: var(--faded);
	margin-top: 18px;
	letter-spacing: 0.18em;
	text-transform: uppercase;
}

footer {
	border-top: 1px solid var(--ink);
	margin: 80px auto 0;
	max-width: 720px;
	padding: 24px 32px;
	font-family: 'JetBrains Mono', monospace;
	font-size: 10px;
	color: var(--faded);
	letter-spacing: 0.14em;
	display: flex;
	justify-content: space-between;
	text-transform: uppercase;
}

.inline-link {
	color: var(--ink);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: 3px;
}
.inline-link:hover { text-decoration-thickness: 2px; }

#install pre.terminal { margin-top: 12px; }

/* Mobile: scale the hero down and tighten layout. The keystone block can
   blow out the viewport on a phone if left at 88px, and the section
   margins are too generous for a small screen. */
@media (max-width: 640px) {
	.container { padding: 32px 20px; }
	h1 { font-size: 40px; line-height: 1.05; letter-spacing: -0.025em; }
	h2 { font-size: 26px; margin: 48px 0 12px; }
	.subhead { font-size: 17px; }
	.keystone { margin: 64px 0; padding: 40px 0; }
	.keystone h2 { font-size: 52px; letter-spacing: -0.04em; }
	.keystone .vs { text-decoration-thickness: 3px; text-underline-offset: 6px; }
	blockquote { font-size: 24px; margin: 48px 0 24px; }
	pre { font-size: 11.5px; padding: 14px 16px; }
	.signature { font-size: 9px; padding: 5px 10px; gap: 8px; }
	nav { padding: 14px 20px; }
	nav .right a { margin-left: 14px; font-size: 11px; }
	.receipt-line { grid-template-columns: 20px 64px 1fr; gap: 8px; }
	.receipt-line .body { font-size: 12px; }
	footer { padding: 20px 24px; flex-direction: column; gap: 8px; }
}

/* Very narrow phones: drop the line-break in the hero so it doesn't wrap weirdly. */
@media (max-width: 380px) {
	h1 { font-size: 34px; }
	.keystone h2 { font-size: 44px; }
}
`;
