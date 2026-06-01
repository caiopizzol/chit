# @chit-run/cli

The chit CLI. A thin runtime for multi-agent workflows. Stop being the glue between your agents.

chit reads a small declared manifest that captures a routine you already run by hand (which agents take part, in what order, what context flows between them, where a reviewer checks) and runs it for you.

## Requirements

Bun. The CLI runs under the Bun runtime, so use `bunx` (or install Bun first).

## Use

```sh
bunx @chit-run/cli --help
bunx @chit-run/cli show path/to/your-manifest.json
bunx @chit-run/cli run path/to/your-manifest.json --input question="..."
```

The installed binary is `chit`:

```sh
chit run <manifest.json> [options]
```

Manifests are small JSON files you write. Example manifests live in the source repo under `examples/` (they are not bundled with this package); see the docs to write your own.

## chit studio

`chit studio`, the local visual editor, needs the Studio client assets, which ship only in a source checkout and not in this npm package. From a published install the `studio` command is not functional in this version. To use Studio, clone the repo and run `bun run studio:preview`.

## Docs

Website and docs: https://chit.run

- Manifests, surfaces, and the implement/check loop: https://chit.run/docs
- MCP stepwise surface: https://chit.run/docs/mcp

## License

MIT
