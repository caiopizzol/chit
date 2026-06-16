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
						<span className="cmd">$ chit init implement --template loop</span>
						{"\n"}
						<span className="cmd">$ chit run implement --input task="add a --version flag"</span>
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
        { "id": "build", "call": "builder", "prompt": "{{ inputs.task }}" },
        {
          "id": "review",
          "call": "reviewer",
          "prompt": "{{ diff }}\nReturn JSON only with passed and issues fields.",
          "json": {
            "schema": {
              "type": "object",
              "required": ["passed", "issues"],
              "properties": {
                "passed": { "type": "boolean" },
                "issues": { "type": "array", "items": { "type": "string" } }
              }
            }
          }
        },
        { "id": "verify", "check": "bun test" }
      ],
      "repeat": {
        "until": {
          "all": ["checks-pass", { "step": "review", "path": "passed", "equals": true }]
        },
        "maxIterations": 3
      }
    }
  }
}`}</pre>

				<h2>Run it from chat.</h2>
				<p className="lede">
					You can ask Claude or Codex to run Chit from the session you already have open. Chit still owns the loop, the
					sandbox, the checks, the receipt, and the patch.
				</p>
				<div className="chat-panel">
					<div className="chat-message user">
						<div className="chat-label">You</div>
						<div className="chat-body">
							Run Chit for this task: add a <code>--version</code> flag. Use the implement routine and show me the patch
							before applying it.
						</div>
					</div>
					<div className="chat-message agent">
						<div className="chat-label">Codex</div>
						<pre className="terminal">{`$ chit run implement --input task="add a --version flag"

iteration 1
  call builder done in 1m18s
  call reviewer done in 22s
  check bun test -> ok in 640ms

run converged

src/cli.ts          | 7 +++++++
src/version.test.ts | 14 ++++++++++++++
2 files changed, 21 insertions(+)

dry run -- review with:
chit trace --full run-a1b5efea

apply exactly it with:
chit apply run-a1b5efea`}</pre>
					</div>
				</div>

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
loop:   repeat the steps until all checks pass and review.passed == true, max 3 iterations
limits: per call 30m, whole run 120m

note: runs in a git-worktree sandbox -- dry run by default (shows the diff,
      discards it); review the diff, then chit apply <run-id> to apply it.`}</pre>

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
			</div>

			<footer>
				<span>chit · early · 2026</span>
				<span>open source · MIT</span>
			</footer>
		</div>
	);
}
