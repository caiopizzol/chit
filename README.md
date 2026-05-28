# chit

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

## What this is

A chit is a small declared file that captures a routine you already run by hand: which agents take part, in what order, what context flows between them, where a validator checks, where you check. The runtime reads the chit and runs it inside your Claude Code or CLI session. You stop being the copy-paste layer between two terminals.

The manifest is the artifact. A shared runtime executes it. Surfaces (Claude Code skill, MCP tool, CLI command) are thin shims that call the runtime with a manifest id and inputs.

## What this isn't

- Not a workflow engine. No schedulers, triggers, cron, databases, SaaS connectors.
- Not a code generator. Manifests are interpreted, not compiled.
- Not an agent framework. We do not define how agents reason.
- Not a chat tool. The word is *chit*, not *chat*.
- Not a dynamic router. v1 ships static DAGs only. Agent-decided handoffs come later if real recipes demand them.

## Layers

1. **Agents.** Registry of invocable participants (Codex CLI, Claude CLI, MCP servers, others via adapters).
2. **Chits.** JSON manifests wiring agents into handoff graphs for a task.
3. **Surfaces.** Adapters that expose a chit as a Claude Code skill, MCP tool, or CLI command.

## Repository layout

This is a Bun workspace monorepo.

```
.
├── apps/
│   ├── cli/        chit CLI: run, install, show, list, uninstall
│   └── web/        landing site: Hono on Cloudflare Workers + Assets
└── packages/
    └── core/       browser-safe core: manifest parser, agents registry, graph model,
                    install marker, show renderer. Imported by apps/cli and apps/web.
```

## Status

Pre-v0. Shipped today: runtime, CLI, Claude Code skill surface, inspector (ASCII / JSON / Mermaid / HTML), install marker, safe lifecycle, browser-safe core boundary. Not shipped: audit log, Studio web UI, MCP surface, declared human-checkpoint steps.

See `brand.md` for positioning and voice. See `apps/cli/examples/` for the canonical manifests:

- `investigate-bug.json`: sequential with verification.
- `consult.json`: parallel fan-out (the consult-two-models pattern).

## Develop

```sh
bun install                       # workspace install
bun --filter '*' test             # all tests across workspaces
bun --filter '*' typecheck        # all typechecks
bun run check                     # biome (lint + format)
bun run check:browser             # @chit/core node-leakage check
bun run cli ...                   # chit-cli from root
bun run web:dev                   # apps/web local server (wrangler dev)
bun run web:deploy                # apps/web to Cloudflare Workers
```

## License

MIT.
