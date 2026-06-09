# @chit-run/cli

[![release](https://img.shields.io/npm/v/%40chit-run%2Fcli?label=release)](https://www.npmjs.com/package/@chit-run/cli)

A thin runtime for multi-agent workflows. Stop being the glue between your agents.

## Install

Requires [Bun](https://bun.sh).

```sh
bunx @chit-run/cli --help
```

Or install the `chit` binary:

```sh
bun install -g @chit-run/cli
chit --help
```

## Use

```sh
chit show path/to/your-manifest.json
chit run path/to/your-manifest.json --input question="..."
chit audit list
```

Manifests are small JSON files you write. Example manifests live in the source repo under `examples/`; they are not bundled with this package.

## Studio

`chit studio` opens a live control tower in your browser: what is running across Chit right now, with a session rail, a selected run's detail, a small event console, and a stop action for background runs. It ships with this package, so it works from a published install:

```sh
chit studio
```

It needs no manifest in the directory. Press Ctrl-C to stop.

## Docs

Website and docs: https://chit.run

## License

MIT
