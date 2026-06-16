import type { Metadata } from "next";
import "./landing.css";

export const metadata: Metadata = {
	title: { absolute: "chit - a thin runtime for multi-agent workflows" },
	description:
		"A routine is a declared workflow: who runs, in what order, what context flows, where a check gates. chit reads the config and runs it. Codex, Claude, Gemini. Stop being the glue between your agents.",
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
					One agent proposes. Another reviews. A check gates the result. A routine captures that in a file the runtime
					reads. Codex, Claude, Gemini, your shell. You step in when judgment matters.
				</p>
				<a href="#install" className="cta">
					$ chit run implement
				</a>

				<div className="keystone">
					<h2>
						chit, <span className="vs">not chat</span>.
					</h2>
					<p>Chat is one agent at a time with you in the middle. A chit takes the middle out.</p>
				</div>

				<section id="install">
					<h2>Start in an existing project</h2>
					<p className="lede">
						chit is early. It runs under Bun and shells out to the agent CLIs you already have installed (
						<code>claude</code>, <code>codex</code>, <code>gemini</code>). No API keys, no HTTP. Install it once, then
						run it in any project.
					</p>
					<pre className="terminal">
						<span className="cmd">$ bun add -g @chit-run/cli</span>
						{"\n\n"}
						<span className="meta"># then, in your project:</span>
						{"\n"}
						<span className="cmd">$ chit doctor</span>
						{"\n"}
						<span className="cmd">$ chit init implement --template loop</span>
					</pre>
					<p className="lede" style={{ marginTop: 16 }}>
						Full walkthrough in{" "}
						<a className="inline-link" href="/docs">
							the docs
						</a>
						: the install-to-first-run path, then the config reference.
					</p>
				</section>

				<h2>The chit is the routine.</h2>
				<p className="lede">
					A routine declares who runs, what context flows forward, and when a loop stops. There is no policy to pick:
					how it runs is derived from the shape. A check or a writing agent runs it sandboxed; a repeat makes it a loop.
				</p>
				<pre>{`{
  "profiles": {
    "claude": { "adapter": "claude", "model": "claude-opus-4-8", "effort": "max" },
    "codex": { "adapter": "codex", "model": "gpt-5.5" }
  },
  "routines": {
    "implement": {
      "input": "task",
      "agents": {
        "builder":  { "profile": "claude", "instructions": "Implement the smallest correct change.", "filesystem": "read-write" },
        "reviewer": { "profile": "codex",  "instructions": "Review the diff. Do not edit files.",     "filesystem": "read-only" }
      },
      "steps": [
        { "id": "build",  "call": "builder", "prompt": "{{ inputs.task }}" },
        { "id": "review", "call": "reviewer", "prompt": "{{ diff }}" },
        { "id": "verify", "check": "bun test" }
      ],
      "repeat": { "until": "checks-pass", "maxIterations": 3 }
    }
  }
}`}</pre>

				<h2>The run says what ran.</h2>
				<p className="lede">
					A writing run starts from HEAD in a throwaway git worktree, loops until the checks pass, and stops at a patch.
					Nothing touches your tree until you apply it. No chat log.
				</p>
				<pre className="terminal">
					<span className="cmd">{`$ chit run implement --input task="add a --version flag"`}</span>
					{"\n\n"}
					<span className="pass-line">run converged (2 iterations)</span>
					{"\n\n"}
					<span className="meta">{` src/cli.ts          | 7 +++++++
 src/version.test.ts | 14 ++++++++++++++
 2 files changed, 21 insertions(+)`}</span>
					{"\n\n"}
					{`dry run -- the diff above is saved. apply exactly it with:  `}
					<span className="cmd">chit apply run-a1b5efea</span>
					{"\n"}
				</pre>

				<h2>Read it before it runs.</h2>
				<p className="lede">
					<code>chit inspect</code> resolves the routine, binds each agent to a real adapter and model, and shows the
					steps and limits before anything runs. If the config is invalid, the run never starts.
				</p>
				<pre>{`$ chit inspect implement
implement  (loop)

inputs:
  task  required

agents:
  builder   claude -> claude:claude-opus-4-8 effort=max     filesystem: read-write
  reviewer  codex -> codex:gpt-5.5                           filesystem: read-only

steps:
  1. build       call builder
  2. review      call reviewer
  3. verify      check: sh -c bun test
loop:   repeat the steps until all checks pass, max 3 iterations
limits: per call 30m, whole run 120m

note: runs in a git-worktree sandbox -- dry run by default (shows the diff,
      discards it); review the diff, then chit apply <run-id> to apply it.`}</pre>

				<h2>Validated before it runs.</h2>
				<p className="lede">
					The config is checked against a schema and the parser before any model is called. An impossible binding fails
					at parse, not three steps in.
				</p>
				<div className="receipt-block">
					<div className="receipt-line pass">
						<div className="ind" />
						<div className="label">PASS</div>
						<div className="body">config valid · profiles bind, the routine resolves, every step is typed</div>
					</div>
					<div className="receipt-line fail">
						<div className="ind" />
						<div className="label">FAIL</div>
						<div className="body">
							impossible binding · <code>codex:sonnet</code> is rejected at parse, before a model runs
						</div>
					</div>
					<div className="receipt-line fail">
						<div className="ind" />
						<div className="label">FAIL</div>
						<div className="body">dirty worktree · a sandboxed run must start from a clean HEAD, or it refuses</div>
					</div>
				</div>

				<h2>The dry run is the default.</h2>
				<p className="lede">A sandboxed run produces a patch and stops. You decide what happens next.</p>
				<div className="modes">
					<div className="mode-line">
						<div className="label">Dry run</div>
						<div className="body">
							The run executes in a git worktree and saves the exact patch. Your working tree is untouched.
						</div>
					</div>
					<div className="mode-line">
						<div className="label">Review</div>
						<div className="body">
							<code>chit trace &lt;run-id&gt;</code> shows what each step and iteration did, with the resolved bindings.
						</div>
					</div>
					<div className="mode-line">
						<div className="label">Apply</div>
						<div className="body">
							<code>chit apply &lt;run-id&gt;</code> replays that exact patch through a gate: same HEAD, clean tree,{" "}
							<code>git apply --check</code>.
						</div>
					</div>
				</div>

				<blockquote>
					The agents think.
					<br />
					chit moves the work.
					<cite>field note</cite>
				</blockquote>

				<h3>Honest about being early</h3>
				<p className="lede">
					Still intentionally small: no scheduler, hosted service, dynamic routing, durable resume, or visual config
					editor. Adapters are in: claude, codex, and gemini, picked per agent in config.
				</p>
			</div>

			<footer>
				<span>chit · early · 2026</span>
				<span>open source · MIT</span>
			</footer>
		</div>
	);
}
