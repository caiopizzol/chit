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

`chit studio`, the local visual editor, needs the Studio client assets. Those ship in a source checkout, not in this npm package. From a published install the `studio` command is not functional in this version.

To use Studio:

```sh
git clone https://github.com/caiopizzol/chit
cd chit
bun install
bun run studio:preview
```

## Docs

Website and docs: https://chit.run

## License

MIT
