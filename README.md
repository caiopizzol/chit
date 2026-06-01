# <img src="apps/site/app/icon.svg" alt="" width="28" height="28"> chit

[![release](https://img.shields.io/npm/v/%40chit-run%2Fcli?label=release)](https://www.npmjs.com/package/@chit-run/cli)

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

Website and docs: https://chit.run

## What It Does

A chit is a small JSON file that declares a routine you already run by hand: which agents participate, what order they run in, what context flows between them, and where a reviewer checks the work.

The runtime reads the chit and runs it inside your CLI, Claude Code, or MCP session. The manifest is the artifact; the surfaces are thin shims.

Chit is not an agent framework, workflow engine, SaaS dashboard, dynamic router, or chat tool. It is the declared routine between your agents.

## Install

Requires [Bun](https://bun.sh).

```sh
bunx @chit-run/cli --help
```

The package installs the `chit` binary:

```sh
bun install -g @chit-run/cli
chit --help
```

Upgrade with `bun update -g @chit-run/cli` (or re-run the global install). Register the MCP server from the installed binary with `claude mcp add chit --scope local -- chit mcp`.

## Try The Examples

The npm package ships the CLI. The example manifests live in this repo.

```sh
git clone https://github.com/caiopizzol/chit
cd chit
bun install

bun run cli show examples/consult.json
bun run cli run examples/consult.json --scope demo --input question="What is a monorepo?"
```

## Core Commands

```sh
chit run <manifest.json> [options]      # execute a chit
chit show <manifest.json>               # inspect without running
chit install <manifest.json> --as claude-skill
chit studio [path]                      # source checkout only in this version
chit converge --task <text> --scope <id>
chit audit list
```

## Repository Layout

```text
apps/cli      @chit-run/cli, the CLI and MCP surface
apps/site     @chit-run/site, the landing page and Fumadocs docs
apps/studio   @chit-run/studio, the local visual editor
packages/core @chit-run/core, browser-safe parser/model/graph logic
examples/     canonical chit manifests
design/       living technical contracts
fixtures/     test fixtures
research/     historical notes, non-authoritative
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

## Contribuidores

<a href="https://github.com/caiopizzol"><img src="https://github.com/caiopizzol.png" width="50" height="50" alt="caiopizzol" title="Caio Pizzol" /></a>
