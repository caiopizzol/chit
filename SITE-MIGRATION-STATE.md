# Site migration + minimal rewrite - state

## Objective
Bring the marketing site + docs into chit-minimal (copied from `../chit/apps/site`)
and rewrite all public copy to describe what chit-minimal actually does: a minimal
runtime harness where a routine is a declared workflow. Drop the old, heavier story
(scopes, sealed markers, Studio, four inspector views, three execution modes, MCP-first).

## Decisions (from the user, 2026-06-15)
- Copy the site (leave the `../chit` monorepo intact). Retire the old site later.
- Convert chit-minimal into a workspace monorepo: `packages/cli` + `apps/site`.
- Copy `brand.md` as the voice guide (paper-and-ink, terse, no em dashes,
  "Stop being the glue", "chit, not chat"). Content describes only what ships in
  chit-minimal. brand.md's unshipped feature claims get reconciled later.
- Domain: `chit.run` (matches brand). Update schema `$id`, `$schema` URLs, docs.

## Ground truth verified against src (do not trust the old copy)
- Real CLI: `init [--template text|loop|check]`, `routines`, `inspect`, `run`,
  `trace`, `apply`, `cleanup`, `help`.
- Real model: config (`profiles` + `routines`), manifest = inputs + agents +
  ordered `steps` ARRAY + optional `repeat`/`output`/`limits`. Step kinds:
  call/format/check/routine/ask. Loops: `checks-pass` | `{step,equals}` | `{all}`.
  filesystem none/read-only/read-write. Sandbox = git worktree; dry-run + `chit apply`.
- NOT in chit-minimal: Studio, MCP server, markers, scopes, batch, four views.
- Schema `$id` currently `https://chit.dev/...` -> change to `chit.run`.
- chit-minimal repo: branch `master`, NO git remote, package `chit-minimal` (private),
  bin `chit -> ./src/index.ts`, devDeps ajv/@types/bun/typescript.

## Surfaces and their state
- `apps/site/app/page.tsx` (landing): OLD approach. Full rewrite. (per_scope, --scope,
  marker, Studio, "ASCII/JSON/Mermaid/HTML", Foreground/Background/Batch - all stale.)
- `content/docs/index.mdx`: already the minimal model and accurate. Light polish.
- `content/docs/config.mdx`: accurate API-style reference. Keep; ADD a "Validation"
  section (what the parser rejects) and align `$schema` to chit.run.
- Custom MDX visuals in `components/doc-visuals.tsx` (RoutinePipelineVisual used by
  index, TwoFileVisual used by config; others available).

## Phases
1. [in progress] Monorepo restructure: move CLI into packages/cli, root workspace
   package.json + tsconfig.base.json. Gate: cli `bun test` (282) + `typecheck` green.
2. [ ] Copy apps/site (exclude build dirs), wire workspace, drop Biome dep. Gate:
   site `typecheck` + static `build` succeed.
3. [ ] Copy brand.md to repo root.
4. [ ] Rewrite landing to the minimal story (real manifest + real CLI transcript).
5. [ ] Polish docs index; keep config; add Validation section; surface the schema.
6. [ ] Align domain to chit.run (schema $id, $schema URLs, site metadata/sitemap,
   schema.test.ts reference). Gate: cli tests still green.
7. [ ] Final verify: cli tests + typecheck, site typecheck + build, no em dashes,
   `git diff --check`. Commit per phase (conventional, no co-author, no push).

## Open items to confirm with user
- Install story + repo URL: chit-minimal has no remote and is unpublished. Landing
  currently says `bunx @chit-run/cli` and links `github.com/caiopizzol/chit`. Need the
  real install path (from source? a future npm name?) and repo link before finalizing
  the landing install section.

## Done log
- (pending) Phase 1.
