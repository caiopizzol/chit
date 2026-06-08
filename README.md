# <img src="apps/site/app/icon.svg" alt="" width="28" height="28"> chit

[![release](https://img.shields.io/npm/v/%40chit-run%2Fcli?label=release)](https://www.npmjs.com/package/@chit-run/cli)

Versioned, cross-vendor agent routines with an audit trail. Stop being the glue between your agents.

Website and docs: https://chit.run

## What It Does

A chit is a small JSON file that declares a routine you already run by hand: which agents take part, in what order, what context flows between them, and where a reviewer checks the work. The runtime reads the chit and runs it, primarily inside a Claude Code conversation over MCP. You stay in the loop and step in where judgment matters.

chit is built for the implement/check loop: one agent implements a slice, another reviews the diff, repeat until it converges or needs you. The roles are assigned in the chit, not fixed to a vendor: either Claude or Codex can implement or review, and the permission you grant a participant decides whether it can write. The bundled default pairs a write-capable Claude implementer with a read-only Codex reviewer. Every run leaves a receipt you can read.

You run it in one of three modes:

- **Foreground.** Checkpoint every iteration. chit runs one round at a time; you read the diff and the verdict, then advance.
- **Background.** Run one task unattended. chit converges in a detached worker against a git worktree; check on it later and read the receipt.
- **Batch.** Run several tasks in parallel, one per worktree, with declared dependencies. chit coordinates the waves; the deliverable is a set of reviewable branches.

chit, not chat. Chat is one agent at a time with you in the middle, holding the thread. A chit takes the middle out: the routine is a declared file, the runtime moves the work between agents, and an audited run leaves a receipt you can read.

chit is not a general workflow engine: no hosted scheduler, no cron, no SaaS connectors, no dynamic router. It is the declared routine between your agents, with a receipt.

## Quickstart (MCP, inside Claude Code)

Requires [Bun](https://bun.sh). Install the CLI, check your setup, and register the MCP server:

```sh
bun install -g @chit-run/cli@latest
chit doctor
claude mcp add chit --scope local -- chit mcp
```

`chit doctor` verifies first-time setup: Bun, the `chit` binary on PATH, the `codex` and `claude` CLIs, the agent registry, MCP registration, the audit directory, and whether you are in a git repo. It runs no agents; it writes and removes one probe file in the audit dir to confirm that dir is writable, and changes nothing else.

Then, in a Claude Code conversation, in a git worktree:

> Use chit to start a run that converges on this task: <a small, scoped change>. Run a couple of iterations and show me the audit trail.

chit opens the run with `chit_start` and advances it with `chit_next`: by default a write-capable Claude implements the slice and a read-only Codex reviews the diff, and each iteration is recorded. Read the receipt with the audit tools. The implementer edits files, so run it against a git worktree, not your main checkout. Upgrade later with the same command: `bun install -g @chit-run/cli@latest` (during 0.x, `bun update -g` will not cross a minor).

## The implement/check loop

The routine chit is built for: one agent implements, another reviews, repeat until it converges or needs you. The roles live in the chit, so either agent can take either side; the permission you grant decides whether it can write. Two ways to drive it, both with a human checkpoint:

- **Supervised.** Your Claude Code chat is the implementer, with its full context; a read-only advisor reviews each round. You own the loop.
- **Autonomous.** chit runs both agents itself in a git worktree, looping to convergence. Drive it from the chat with `chit_start` then `chit_next` (foreground, one iteration per call), or hand it off unattended with `chit_start` and `mode: "background"`. Several tasks at once become a batch (one worktree each, with dependencies). Inspect the loop log and the audit transcript after.

Manifests are static DAGs and cannot loop, so the iteration lives in an orchestrator on top, never in the chit. See [self-hosting](https://chit.run/docs/self-hosting).

## Safety

- Codex runs in a hard OS sandbox chosen by its declared `filesystem` permission: `read_only` runs `--sandbox read-only`, `write` runs `--sandbox workspace-write`.
- Claude read-only is enforced by Claude plan-mode permissions (`--permission-mode plan`), not an OS sandbox.
- The chit-spawned `claude` is launched with strict MCP isolation by default, so it does not inherit your MCP servers.
- Audit transcripts contain full prompts and outputs and can hold secrets; auditing is on for converge and opt-in elsewhere, under your local state dir.
- Run autonomous work against a git worktree, not your main checkout.

## CLI (support tooling)

The same binary backs the CLI commands used for debugging, inspection, and running the loop from a terminal:

```sh
chit run <manifest.json> [options]      # execute a chit
chit show <manifest.json>               # inspect without running
chit converge --task <text> --scope <id>
chit audit list                         # read recorded run transcripts
chit studio                             # live control tower in the browser
chit install <manifest.json> --as claude-skill
```

## Try The Examples

The npm package ships the CLI. The example manifests live in this repo.

```sh
git clone https://github.com/caiopizzol/chit
cd chit
bun install
bun run cli show examples/consult.json
bun run cli run examples/consult.json --scope demo --input question="What is a monorepo?"
```

## Repository Layout

```text
apps/cli      @chit-run/cli, the CLI and the MCP server
apps/site     @chit-run/site, the landing page and Fumadocs docs
apps/studio   @chit-run/studio, the local visual control tower
packages/core @chit-run/core, browser-safe parser/model/graph logic
examples/     canonical chit manifests
fixtures/     test fixtures
```

## Development

```sh
bun install
bun run check
bun run typecheck
bun run test
bun run check:browser
bun run site:dev
bun run studio:preview
```

## License

MIT.

## Contributors

<a href="https://github.com/caiopizzol"><img src="https://github.com/caiopizzol.png" width="50" height="50" alt="caiopizzol" title="Caio Pizzol" /></a>
