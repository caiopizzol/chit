# chit

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

## What this is

A chit is a small declared file that captures a routine you already run by hand: which agents take part, in what order, what context flows between them, where a reviewer checks, where you check. The runtime reads the chit and runs it inside your Claude Code, MCP, or CLI session. You stop being the copy-paste layer between two terminals.

The manifest is the artifact. A shared runtime executes it. Surfaces (Claude Code skill, MCP tools, CLI command) are thin shims that call the runtime with a manifest and inputs.

## What this isn't

- Not a workflow engine. No schedulers, triggers, cron, databases, SaaS connectors.
- Not a code generator. Manifests are interpreted, not compiled.
- Not an agent framework. We do not define how agents reason; we define how they hand work to each other.
- Not a chat tool. The word is *chit*, not *chat*.
- Not a dynamic router. Manifests are static DAGs: no loops, no conditionals. Iteration, when you want it, is driven by an orchestrator on top, never by the manifest.

## Layers

1. **Agents.** Registry of invocable participants (Codex CLI, Claude CLI, others via adapters).
2. **Chits.** JSON manifests wiring agents into handoff graphs for a task.
3. **Surfaces.** Adapters that expose a chit as a Claude Code skill, MCP tools, or a CLI command.

## Surfaces

- **CLI.** `chit run | show | install | list | uninstall | studio | loop-log | converge | audit`.
- **Claude Code skill.** Install a chit as a slash-invocable skill.
- **MCP (stepwise).** `chit_start`, then `chit_run_step` per step with a live heartbeat, so each handoff is a separate visible tool call you can watch and cancel. See `docs/mcp-v0.md`.
- **Studio.** A local web editor for chits (graph view + inspector) plus a read-only Loops drawer that renders convergence-log runs and opens a run's audit transcript. `chit studio [path]`. Early.

## The implement/check loop

chit runs the recurring routine of "one agent implements, another reviews, repeat until it converges or needs you." Two modes:

- **Supervised.** Your Claude Code chat implements; a chit `per_scope` Codex advisor reviews each round (`apps/cli/examples/implementation-check-thread.json`, which has the reviewer inspect the git diff directly). The chat owns the loop and the human checkpoint. Pattern: `docs/supervised-convergence.md`.
- **Autonomous.** `chit converge` runs both agents: a write-capable Claude implements, a read-only Codex reviews (`apps/cli/examples/converge.json`), looping to convergence. You set the task, run it against a git worktree, then inspect the loop log and audit transcript and run the final gates yourself. Manifests cannot loop, so the iteration lives in the driver, not the chit. Operating guide: `docs/self-hosting.md`.

A run can record a convergence log (`chit loop-log`, written to `.chit/loops/<id>.jsonl`) that Studio's Loops drawer renders.

An audited run also records a full transcript (rendered prompts, outputs, and token usage as content-addressed blobs) under the local state dir. `chit converge` audits by default; `chit run --audit` and the MCP `chit_start audit:true` are opt-in (blobs can hold secrets). Read it with `chit audit list` / `chit audit show <runId>`, or open it from a loop in Studio. Retention is bounded by default. See `docs/audit-v0.md`.

## Repository layout

Bun workspace monorepo.

```
.
├── apps/
│   ├── cli/        chit CLI + the MCP stepwise surface
│   ├── docs/       public landing + docs: Next.js + Fumadocs static export
│   └── studio/     local web editor (graph + inspector + Loops drawer)
└── packages/
    └── core/       browser-safe core: manifest parser, agents registry, graph
                    model, convergence-log model, install marker, show renderer.
```

## Status

Early, and honest about it. Shipped: the runtime; the CLI (`run` / `install` / `show` / `list` / `uninstall` / `studio` / `loop-log` / `converge` / `audit`); the Claude Code skill surface; the MCP stepwise surface; the inspector (ASCII / JSON / Mermaid / HTML); Studio (graph editor + read-only Loops view + audit transcript view); the convergence log; supervised and autonomous implement/check loops; the audit log (full prompt/output transcripts on all three run surfaces, with retention, readable via `chit audit` and Studio); the install marker and safe lifecycle; the browser-safe core boundary; preservation of both adapters' observable event streams (Codex JSONL and Claude stream-json: tool events, command executions, reasoning summaries the CLIs emit) as audit events on audited runs. Not shipped: declared human-checkpoint or loop steps inside manifests (static DAGs, by design); recording which manifest a loop ran. Adapter events are surfaced live as they arrive, recorded with real arrival timestamps on audited runs; this is the observable CLI event stream, never hidden model reasoning.

Canonical manifests in `apps/cli/examples/`:

- `investigate-bug.json`: sequential, with verification.
- `consult.json`: parallel fan-out (consult two models).
- `implementation-check-thread.json`: the per_scope Codex checker for supervised convergence.
- `converge.json`: the autonomous loop (Claude implements with write access, Codex reviews read-only).

## Develop

```sh
bun install                       # workspace install
bun --filter '*' test             # all tests across workspaces
bun --filter '*' typecheck        # all typechecks
bun run check                     # biome (lint + format)
bun run check:browser             # @chit/core node-leakage check
bun run cli ...                   # chit-cli from root
bun run docs:dev                  # public site + docs local server
bun run studio:preview            # build and launch the local Studio
```

## License

MIT.
