// Track A home: a form that takes a manifest path, plus quick-links to the
// canonical examples in apps/cli/examples. No editing, no upload, no run.

const EXAMPLES = [
	{ name: "consult", path: "apps/cli/examples/consult.json" },
	{ name: "consult-stateless", path: "apps/cli/examples/consult-stateless.json" },
	{ name: "ask-codex", path: "apps/cli/examples/ask-codex.json" },
	{ name: "ask-claude", path: "apps/cli/examples/ask-claude.json" },
	{ name: "investigate-bug", path: "apps/cli/examples/investigate-bug.json" },
];

const STYLES = `
:root {
	--bg: #F4F2EA;
	--sheet: #EAE5D5;
	--receipt: #E0DBC6;
	--ink: #0A0A0A;
	--carbon: #2A2A2A;
	--faded: #807766;
	--hairline: #C7BFAB;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }
body { font-family: 'Inter', system-ui, sans-serif; font-size: 15px; line-height: 1.6; }
.container { max-width: 720px; margin: 0 auto; padding: 56px 32px; }
nav {
	display: flex; justify-content: space-between; align-items: center;
	padding: 18px 32px; border-bottom: 1px solid var(--ink);
	background: var(--bg); max-width: 720px; margin: 0 auto;
}
.wordmark { font-family: 'Bricolage Grotesque', serif; font-weight: 700; font-size: 20px; }
.wordmark .light { color: var(--faded); font-weight: 500; }
nav .tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--faded); text-transform: uppercase; letter-spacing: 0.12em; }
h1 { font-family: 'Bricolage Grotesque', serif; font-weight: 700; font-size: 48px; line-height: 1.05; letter-spacing: -0.03em; margin: 24px 0 16px; }
.subhead { font-size: 17px; color: var(--carbon); max-width: 580px; margin: 0 0 32px; }
h2 { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; margin: 48px 0 12px; }
form { margin: 16px 0 0; display: flex; gap: 8px; }
input[type=text] {
	flex: 1; padding: 12px 14px; border: 1px solid var(--ink); background: var(--sheet);
	font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--ink);
}
input[type=text]:focus { outline: 2px solid var(--ink); outline-offset: -2px; }
button {
	padding: 12px 20px; background: var(--ink); color: var(--bg);
	border: none; font-family: 'JetBrains Mono', monospace; font-size: 12px;
	letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer;
}
button:hover { background: var(--carbon); }
.examples { display: grid; grid-template-columns: 1fr; gap: 8px; margin: 8px 0 0; }
.examples a {
	display: grid; grid-template-columns: 160px 1fr; gap: 16px; padding: 12px 14px;
	border: 1px solid var(--hairline); background: var(--sheet);
	color: var(--ink); text-decoration: none;
	font-family: 'JetBrains Mono', monospace; font-size: 12.5px;
	align-items: baseline;
}
.examples a:hover { border-color: var(--ink); }
.examples .name { font-weight: 600; }
.examples .path { color: var(--faded); }
.note { font-size: 13px; color: var(--carbon); margin: 12px 0 0; line-height: 1.5; }
.note code { background: var(--receipt); padding: 1px 6px; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
`;

export function Home() {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>chit studio</title>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
				<link
					href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
					rel="stylesheet"
				/>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Hono SSR inspector pattern, scheduled for deletion in slice 1 sub-unit 1.4 */}
				<style dangerouslySetInnerHTML={{ __html: STYLES }} />
			</head>
			<body>
				<nav>
					<span class="wordmark">
						chit <span class="light">studio</span>
					</span>
					<span class="tag">Track A · read-only</span>
				</nav>
				<div class="container">
					<h1>Inspect a chit.</h1>
					<p class="subhead">
						Pick a manifest file. Studio parses it with @chit/core and renders the same graph the
						CLI emits with chit show --format html.
					</p>

					<h2>Pick a manifest</h2>
					<form action="/inspect" method="get">
						<input type="text" name="path" placeholder="apps/cli/examples/consult.json" required />
						<button type="submit">Inspect</button>
					</form>

					<h2>Canonical examples</h2>
					<div class="examples">
						{EXAMPLES.map((ex) => (
							// biome-ignore lint/correctness/useJsxKeyInIterable: Hono SSR doesn't require React keys, scheduled for deletion in slice 1 sub-unit 1.4
							<a href={`/inspect?path=${encodeURIComponent(ex.path)}`}>
								<span class="name">{ex.name}</span>
								<span class="path">{ex.path}</span>
							</a>
						))}
					</div>

					<p class="note">
						Track A is read-only. Editing, registry browsing, run-from-Studio, and the
						human-checkpoint step type come later. Relative paths resolve from the workspace root,
						so the quick links above work regardless of how <code>chit-studio</code> was started.
					</p>
				</div>
			</body>
		</html>
	);
}
