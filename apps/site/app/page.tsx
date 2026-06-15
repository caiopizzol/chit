import type { Metadata } from "next";
import "./landing.css";

export const metadata: Metadata = {
	title: { absolute: "chit - versioned, cross-vendor agent routines" },
	description:
		"Turn the agent handoff you already run by hand into a versioned, cross-vendor routine with an audit trail. Stop being the glue between your agents.",
};

export default function Home() {
	return (
		<div className="landing">
			<nav>
				<span className="wordmark">chit</span>
				<span className="right">
					<a href="/docs">docs</a>
					<a href="https://github.com/caiopizzol/chit">github</a>
					<a href="#install">install</a>
				</span>
			</nav>

			<div className="container">
				<h1>
					Stop being the glue
					<br />
					between your agents.
				</h1>
				<p className="subhead">
					One agent proposes. Another verifies. Another executes. A chit captures the routine in a
					file the runtime reads. Codex, Claude, MCP, your shell. Choreographed. You step in when
					judgment matters.
				</p>
				<a href="#install" className="cta">
					$ bunx @chit-run/cli
				</a>

				<div className="keystone">
					<h2>
						chit, <span className="vs">not chat</span>.
					</h2>
					<p>Chat is one agent at a time with you in the middle. A chit takes the middle out.</p>
				</div>

				<h2>The chit is the routine.</h2>
				<p className="lede">
					A chit declares who runs, what context flows, what permissions apply, and where the work
					goes next. The runtime reads the chit. The output shows what ran.
				</p>
				<pre>
					<span className="key">{"{"}</span>
					{"\n  "}
					<span className="key">"id"</span>: <span className="str">"consult"</span>,{"\n  "}
					<span className="key">"description"</span>:{" "}
					<span className="str">"Ask Codex and Claude. Format the answer."</span>,{"\n  "}
					<span className="key">"participants"</span>: {"{"}
					{"\n    "}
					<span className="key">"codex"</span>: {"{"} <span className="key">"agent"</span>:{" "}
					<span className="str">"codex"</span>,{"\n                "}
					<span className="key">"session"</span>: <span className="str">"per_scope"</span> {"}"},
					{"\n    "}
					<span className="key">"claude"</span>: {"{"} <span className="key">"agent"</span>:{" "}
					<span className="str">"claude"</span>,{"\n                "}
					<span className="key">"session"</span>: <span className="str">"per_scope"</span>,
					{"\n                "}
					<span className="key">"permissions"</span>: {"{"}
					{"\n                  "}
					<span className="key">"filesystem"</span>: <span className="str">"read_only"</span> {"}"}{" "}
					{"}"}
					{"\n  "}
					{"}"},{"\n  "}
					<span className="key">"steps"</span>: {"{"}
					{"\n    "}
					<span className="key">"ask_codex"</span>: {"{"} <span className="key">"call"</span>:{" "}
					<span className="str">"codex"</span> {"}"},{"\n    "}
					<span className="key">"ask_claude"</span>: {"{"} <span className="key">"call"</span>:{" "}
					<span className="str">"claude"</span> {"}"},{"\n    "}
					<span className="key">"out"</span>: {"{"} <span className="key">"format"</span>:{" "}
					<span className="str">"## codex\\n..."</span> {"}"}
					{"\n  "}
					{"}"}
					{"\n"}
					{"}"}
				</pre>

				<h2>The run says what ran.</h2>
				<p className="lede">The CLI says what ran. No chat log.</p>
				<pre className="terminal">
					<span className="cmd">$ chit run examples/consult.json --scope work-session</span>
					{"\n"}
					<span className="meta">manifest: consult</span>
					{"\n"}
					<span className="meta">scope: work-session-7f24089cc56</span>
					{"\n"}
					<span className="meta">adapters: codex-exec, claude-cli</span>
					{"\n\nvalidation:\n  "}
					<span className="pass-line">capabilities: compatible</span>
					{"\n  "}
					<span className="pass-line">agents: resolved</span>
					{"\n  "}
					<span className="pass-line">permissions: read_only enforced</span>
					{
						"\n    codex via --sandbox read-only;\n    claude via --permission-mode plan\n\nexecution:\n  level 0:  ask_codex, ask_claude\n  level 1:  out\n\n"
					}
					<span className="pass-line">run passes</span>
					{"\n"}
				</pre>

				<h2>Read the chit before it fires.</h2>
				<p className="lede">Four views of the same graph: ASCII, JSON, Mermaid, HTML.</p>
				<div className="graph">
					<svg viewBox="0 0 660 260" width="100%" role="img" aria-label="chit execution graph">
						<line x1="150" y1="125" x2="245" y2="75" stroke="#0A0A0A" strokeWidth="1.2" />
						<line x1="150" y1="135" x2="245" y2="185" stroke="#0A0A0A" strokeWidth="1.2" />
						<line x1="385" y1="75" x2="480" y2="125" stroke="#0A0A0A" strokeWidth="1.2" />
						<line x1="385" y1="185" x2="480" y2="135" stroke="#0A0A0A" strokeWidth="1.2" />
						<rect
							x="20"
							y="100"
							width="130"
							height="55"
							fill="#F4F2EA"
							stroke="#0A0A0A"
							strokeWidth="1.5"
						/>
						<text x="85" y="126" textAnchor="middle" fontSize="12" fill="#0A0A0A" fontWeight="600">
							inputs
						</text>
						<text x="85" y="142" textAnchor="middle" fontSize="10" fill="#2A2A2A">
							question
						</text>
						<rect
							x="245"
							y="45"
							width="140"
							height="55"
							fill="#F4F2EA"
							stroke="#0A0A0A"
							strokeWidth="1.5"
						/>
						<text x="315" y="71" textAnchor="middle" fontSize="12" fill="#0A0A0A" fontWeight="600">
							ask_codex
						</text>
						<text x="315" y="87" textAnchor="middle" fontSize="10" fill="#2A2A2A">
							codex-exec
						</text>
						<rect
							x="245"
							y="160"
							width="140"
							height="55"
							fill="#F4F2EA"
							stroke="#0A0A0A"
							strokeWidth="1.5"
						/>
						<text x="315" y="186" textAnchor="middle" fontSize="12" fill="#0A0A0A" fontWeight="600">
							ask_claude
						</text>
						<text x="315" y="202" textAnchor="middle" fontSize="10" fill="#2A2A2A">
							claude-cli
						</text>
						<rect
							x="480"
							y="100"
							width="140"
							height="55"
							fill="#F4F2EA"
							stroke="#0A0A0A"
							strokeWidth="1.5"
						/>
						<text x="550" y="126" textAnchor="middle" fontSize="12" fill="#0A0A0A" fontWeight="600">
							out
						</text>
						<text x="550" y="142" textAnchor="middle" fontSize="10" fill="#2A2A2A">
							format
						</text>
					</svg>
				</div>

				<h2>Every chit, checked.</h2>
				<p className="lede">
					Permissions are typed. Capabilities are checked. The chit cannot lie about what it
					enforces.
				</p>
				<div className="receipt-block">
					<div className="receipt-line pass">
						<div className="ind" />
						<div className="label">PASS</div>
						<div className="body">capabilities · all required surface capabilities present</div>
					</div>
					<div className="receipt-line warn">
						<div className="ind" />
						<div className="label">WARN</div>
						<div className="body">
							unenforced permission · an adapter that cannot enforce a declared permission needs
							--allow-unenforced-permissions
						</div>
					</div>
					<div className="receipt-line fail">
						<div className="ind" />
						<div className="label">FAIL</div>
						<div className="body">marker mismatch · manifest hash differs from sealed marker</div>
					</div>
				</div>

				<h2>Run it three ways.</h2>
				<p className="lede">The same chit, three execution modes. You choose how much to watch.</p>
				<div className="modes">
					<div className="mode-line">
						<div className="label">Foreground</div>
						<div className="body">
							Checkpoint every iteration. chit runs one round; you read the diff and the verdict,
							then advance.
						</div>
					</div>
					<div className="mode-line">
						<div className="label">Background</div>
						<div className="body">
							Run one task unattended. chit converges in a detached worker against a git worktree.
							Check on it later; read the receipt.
						</div>
					</div>
					<div className="mode-line">
						<div className="label">Batch</div>
						<div className="body">
							Run several tasks in parallel, one worktree each, with declared dependencies. The
							deliverable is a set of reviewable branches.
						</div>
					</div>
				</div>

				<blockquote>
					No chit, no work.
					<br />
					No work, no surprises.
					<cite>chit manifesto</cite>
				</blockquote>

				<section id="install">
					<h2>Install</h2>
					<p className="lede">
						The published CLI is <code>@chit-run/cli</code>. It runs under Bun and installs the{" "}
						<code>chit</code> binary.
					</p>
					<pre className="terminal">
						<span className="cmd">$ bunx @chit-run/cli@latest --help</span>
						{"\n"}
						<span className="cmd">$ bun install -g @chit-run/cli@latest</span>
						{"\n"}
						<span className="cmd">$ chit --help</span>
					</pre>
					<p className="lede" style={{ marginTop: 16 }}>
						Example manifests and Studio live in the source repo. Start with the CLI, then open the
						docs when you want the full surface map.
					</p>
				</section>
			</div>

			<footer>
				<span>chit · early · 2026</span>
				<span>open source · MIT</span>
			</footer>
		</div>
	);
}
