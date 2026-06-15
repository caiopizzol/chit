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
1. [DONE dd97262] Monorepo restructure: CLI in packages/cli, root workspace
   package.json + tsconfig.base.json. cli test 282 pass + typecheck green.
2. [DONE] Copy apps/site (excluded build dirs), dropped Biome `check` script,
   `bun install` (616 pkgs). site typecheck + static build both succeed
   (/, /docs, /docs/config, llms, sitemap).
3. [DONE] Copied brand.md to repo root.
4. [DONE] Rewrote landing (page.tsx) to the minimal story: real config, real
   `chit run` transcript (run converged + dry-run/apply), real `chit inspect`
   block, validation receipts, dry-run/review/apply, honest "early" section.
5. [DONE] index.mdx already accurate (left as-is). config.mdx: added a Validation
   section (every example verified vs the parser) and fixed the wrong "loops
   require maxIterations" line (only judged loops do; checks-pass defaults to 5).
6. [DONE] Domain -> chit.run: schema $id, schema.test.ts, config.mdx $schema URLs,
   site root + llms.txt descriptions. (siteUrl was already chit.run.)
7. [DONE] Verified: cli 282 pass + typecheck, site typecheck + static build,
   no em dashes, git diff --check clean. Rendered output checked (new copy in,
   stale terms out).

## Verification corrections found while writing (standing rule: verify, not assume)
- Old docs said "Loops require maxIterations" -- false. Only judged loops do;
  a checks-pass loop falls back to DEFAULT_MAX_ITERATIONS = 5. Fixed in config.mdx.
- Landing's old run output, four-views, scopes, markers, Studio, batch are not in
  chit-minimal. Replaced with verified `chit run`/`chit inspect` output from views.ts.

## Open items to confirm with user
- Install story + repo URL: chit-minimal has no remote and is unpublished. Landing
  currently says `bunx @chit-run/cli` and links `github.com/caiopizzol/chit`. Need the
  real install path (from source? a future npm name?) and repo link before finalizing
  the landing install section.

## Done log
- (pending) Phase 1.
