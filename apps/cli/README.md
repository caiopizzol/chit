# @chit-run/cli

The chit CLI. A thin runtime for multi-agent workflows. Stop being the glue between your agents.

chit reads a small declared manifest that captures a routine you already run by hand (which agents take part, in what order, what context flows between them, where a reviewer checks) and runs it for you.

## Requirements

Bun. The CLI runs under the Bun runtime, so use `bunx` (or install Bun first).

## Use

```sh
bunx @chit-run/cli --help
bunx @chit-run/cli show examples/consult.json
bunx @chit-run/cli run examples/consult.json --input question="..."
```

The installed binary is `chit`:

```sh
chit run <manifest.json> [options]
```

## Docs

Website and docs: https://chit.run

- Manifests, surfaces, and the implement/check loop: https://chit.run/docs
- MCP stepwise surface: https://chit.run/docs/mcp

## License

MIT
