import { styles } from "../styles";

export function Home() {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>chit. A thin runtime for multi-agent workflows.</title>
				<meta
					name="description"
					content="An open-source runtime for multi-agent workflows. Stop being the glue between your agents."
				/>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
				<link
					href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
					rel="stylesheet"
				/>
				<style dangerouslySetInnerHTML={{ __html: styles }} />
			</head>
			<body>
				<nav>
					<span class="wordmark">chit</span>
					<span class="right">
						<a href="https://github.com/caiopizzol/chit">github</a>
						<a href="#install">install</a>
					</span>
				</nav>

				<div class="container">
					<div class="signature">
						<span class="dot" />
						<span>SEALED</span>
						<span class="v">2026-05-28</span>
						<span>·</span>
						<span class="v">sha256:abc…def</span>
					</div>

					<h1>
						Stop being the glue
						<br />
						between your agents.
					</h1>
					<p class="subhead">
						One agent proposes. Another verifies. Another executes. A chit captures the routine in a
						file the runtime reads. Codex, Claude, MCP, your shell. Choreographed. You step in when
						judgment matters.
					</p>
					<a href="#install" class="cta">
						$ chit install
					</a>

					<div class="keystone">
						<h2>
							chit, <span class="vs">not chat</span>.
						</h2>
						<p>Chat is one agent at a time with you in the middle. A chit takes the middle out.</p>
					</div>

					<h2>The chit is the routine.</h2>
					<p class="lede">
						A chit declares who runs, what context flows, what permissions apply, and where the work
						goes next. The runtime reads the chit. The output shows what ran.
					</p>
					<pre>
						<span class="key">{"{"}</span>
						{"\n  "}
						<span class="key">"id"</span>: <span class="str">"consult"</span>,{"\n  "}
						<span class="key">"description"</span>:{" "}
						<span class="str">"Ask Codex and Claude. Format the answer."</span>,{"\n  "}
						<span class="key">"participants"</span>: {"{"}
						{"\n    "}
						<span class="key">"codex"</span>: {"{"} <span class="key">"agent"</span>:{" "}
						<span class="str">"codex"</span>,{"\n                "}
						<span class="key">"session"</span>: <span class="str">"per_scope"</span> {"}"},
						{"\n    "}
						<span class="key">"claude"</span>: {"{"} <span class="key">"agent"</span>:{" "}
						<span class="str">"claude"</span>,{"\n                "}
						<span class="key">"session"</span>: <span class="str">"per_scope"</span>,
						{"\n                "}
						<span class="key">"permissions"</span>: {"{"}
						{"\n                  "}
						<span class="key">"filesystem"</span>: <span class="str">"read_only"</span> {"}"} {"}"}
						{"\n  "}
						{"}"},{"\n  "}
						<span class="key">"steps"</span>: {"{"}
						{"\n    "}
						<span class="key">"ask_codex"</span>: {"{"} <span class="key">"call"</span>:{" "}
						<span class="str">"codex"</span> {"}"},{"\n    "}
						<span class="key">"ask_claude"</span>: {"{"} <span class="key">"call"</span>:{" "}
						<span class="str">"claude"</span> {"}"},{"\n    "}
						<span class="key">"out"</span>: {"{"} <span class="key">"format"</span>:{" "}
						<span class="str">"## codex\\n..."</span> {"}"}
						{"\n  "}
						{"}"}
						{"\n"}
						{"}"}
					</pre>

					<h2>The run says what ran.</h2>
					<p class="lede">The CLI says what ran. No chat log.</p>
					<pre class="terminal">
						<span class="cmd">$ chit run examples/consult.json --scope work-session</span>
						{"\n"}
						<span class="meta">manifest: consult</span>
						{"\n"}
						<span class="meta">scope: work-session-7f24089cc56</span>
						{"\n"}
						<span class="meta">adapters: codex-exec, claude-cli</span>
						{"\n\nvalidation:\n  "}
						<span class="pass-line">capabilities: compatible</span>
						{"\n  "}
						<span class="pass-line">agents: resolved</span>
						{"\n  "}
						<span class="warn-line">permissions: needs override</span>
						{
							"\n    claude requires filesystem read_only;\n    claude-cli cannot enforce it\n\nexecution:\n  level 0:  ask_codex, ask_claude\n  level 1:  out\n\n"
						}
						<span class="pass-line">run passes</span>
						{"\n"}
					</pre>

					<h2>Read the chit before it fires.</h2>
					<p class="lede">Four views of the same graph: ASCII, JSON, Mermaid, HTML.</p>
					<div class="graph">
						<svg viewBox="0 0 660 260" width="100%" role="img" aria-label="chit execution graph">
							<line x1="150" y1="125" x2="245" y2="75" stroke="#0A0A0A" stroke-width="1.2" />
							<line x1="150" y1="135" x2="245" y2="185" stroke="#0A0A0A" stroke-width="1.2" />
							<line x1="385" y1="75" x2="480" y2="125" stroke="#0A0A0A" stroke-width="1.2" />
							<line x1="385" y1="185" x2="480" y2="135" stroke="#0A0A0A" stroke-width="1.2" />
							<rect
								x="20"
								y="100"
								width="130"
								height="55"
								fill="#F4F2EA"
								stroke="#0A0A0A"
								stroke-width="1.5"
							/>
							<text
								x="85"
								y="126"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="12"
								fill="#0A0A0A"
								font-weight="600"
							>
								inputs
							</text>
							<text
								x="85"
								y="142"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="10"
								fill="#2A2A2A"
							>
								question
							</text>
							<rect
								x="245"
								y="45"
								width="140"
								height="55"
								fill="#F4F2EA"
								stroke="#0A0A0A"
								stroke-width="1.5"
							/>
							<text
								x="315"
								y="71"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="12"
								fill="#0A0A0A"
								font-weight="600"
							>
								ask_codex
							</text>
							<text
								x="315"
								y="87"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="10"
								fill="#2A2A2A"
							>
								codex-exec
							</text>
							<rect
								x="245"
								y="160"
								width="140"
								height="55"
								fill="#F4F2EA"
								stroke="#0A0A0A"
								stroke-width="1.5"
								stroke-dasharray="3,3"
							/>
							<text
								x="315"
								y="186"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="12"
								fill="#0A0A0A"
								font-weight="600"
							>
								ask_claude
							</text>
							<text
								x="315"
								y="202"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="10"
								fill="#2A2A2A"
							>
								claude-cli · warn
							</text>
							<rect
								x="480"
								y="100"
								width="140"
								height="55"
								fill="#F4F2EA"
								stroke="#0A0A0A"
								stroke-width="1.5"
							/>
							<text
								x="550"
								y="126"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="12"
								fill="#0A0A0A"
								font-weight="600"
							>
								out
							</text>
							<text
								x="550"
								y="142"
								text-anchor="middle"
								font-family="JetBrains Mono"
								font-size="10"
								fill="#2A2A2A"
							>
								format
							</text>
						</svg>
					</div>

					<h2>Every chit, checked.</h2>
					<p class="lede">
						Permissions are typed. Capabilities are checked. The chit cannot lie about what it
						enforces.
					</p>
					<div class="receipt-block">
						<div class="receipt-line pass">
							<div class="ind" />
							<div class="label">PASS</div>
							<div class="body">capabilities · all required surface capabilities present</div>
						</div>
						<div class="receipt-line warn">
							<div class="ind" />
							<div class="label">WARN</div>
							<div class="body">
								permission gap · claude-cli cannot enforce filesystem read_only
							</div>
						</div>
						<div class="receipt-line fail">
							<div class="ind" />
							<div class="label">FAIL</div>
							<div class="body">marker mismatch · manifest hash differs from sealed marker</div>
						</div>
					</div>

					<blockquote>
						No chit, no work.
						<br />
						No work, no surprises.
						<cite>chit manifesto</cite>
					</blockquote>

					<section id="install">
						<h2>Install (soon)</h2>
						<p class="lede">
							Pre-v0. The public repo and the published CLI are not out yet. When they land, the
							flow will be:
						</p>
						<pre class="terminal">
							<span class="cmd">$ git clone https://github.com/caiopizzol/chit</span>
							{"\n"}
							<span class="cmd">$ cd chit</span>
							{"\n"}
							<span class="cmd">$ bun install</span>
							{"\n"}
							<span class="cmd">$ bun run cli --help</span>
						</pre>
						<p class="lede" style="margin-top: 16px;">
							Until then, this page is the brand cut. Nothing to install yet.
						</p>
					</section>
				</div>

				<footer>
					<span>chit · pre-v0 · 2026</span>
					<span>open source · MIT</span>
				</footer>
			</body>
		</html>
	);
}
