# Contributing to chit

chit is a Bun workspace monorepo. It is early (pre-v0); expect rough edges.

## Setup

Install [Bun](https://bun.sh), then:

```sh
bun install
```

That also installs the lefthook pre-commit hook (staged Biome formatting).

## Layout

- `apps/cli` (`@chit/cli`) - the chit CLI and the MCP stepwise surface.
- `apps/site` (`@chit/site`) - the public website: landing page plus Fumadocs docs.
- `apps/studio` (`@chit/studio`) - the local visual editor.
- `packages/core` (`@chit/core`) - browser-safe shared model, parser, and graph logic.
- `examples/` - canonical chit manifests.
- `notes/` - design records and RFCs (see `notes/README.md`); not the published docs.
- `dogfood/` - real-run receipts and trap fixtures.

## Run it

```sh
bun run cli run examples/consult.json --scope dev   # run a chit
bun run site:dev                                     # site + docs at localhost
bun run studio:preview                               # launch Studio on an example
```

## Checks

Run these before opening a PR; CI runs the same set:

```sh
bun run typecheck       # all workspaces
bun run test            # all workspaces
bun run check           # Biome (lint + format)
bun run check:browser   # @chit/core stays browser-safe (no Node-only refs)
bun run site:build      # static export of the site
```

Pre-commit runs staged Biome only (fast); the heavier gates run in CI.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).
- **File names** apply going forward; existing names are migrated opportunistically, not in bulk:
  - React components: `PascalCase.tsx`
  - Hooks: `use-thing.ts`
  - Other TypeScript modules: `kebab-case.ts`
  - Tests: `same-name.test.ts`

## License

By contributing you agree your contributions are licensed under the repository's
[MIT License](./LICENSE).
