# chit-minimal

A from-scratch proof of one idea: **a routine is a declared workflow.** Chit can
**list** it, **inspect** it, **run** it, and show **what happened**. CLI only.

It reuses Chit's *concepts* (manifests, participants, policies, receipts, content
digests) but shares no code with the main runtime, so the product shape can be
judged on its own.

## The model

- A **routine** is the one concept you configure. It has a name and points at a manifest.
- A **manifest** is the source of truth: inputs, participants, steps, policy, prompts, checks.
  Config never restates any of this.
- A **participant** is a named actor (an agent plus instructions plus a filesystem permission).
  Roles like "implementer"/"reviewer" are just participant names, not a built-in vocabulary.
- **one-shot** and **converge** are execution *policies*, not separate products.

```
chit routines                      list declared routines
chit inspect <routine>             what it needs and what will run
chit run <routine> [--input k=v]   run it and print the output
chit trace <run-id>                the receipt for a past run
```

## Quickstart

```bash
bun install                       # only needed for `bun run typecheck`
bun run src/index.ts routines
bun run src/index.ts inspect feature-griller
bun run src/index.ts run feature-griller --input idea="add dark mode"
bun run src/index.ts trace <run-id>
bun test                          # 62 tests, no real model calls (fake adapter)
```

`run` executes for real by shelling out to the `claude` CLI (already on your
machine, no API keys, no HTTP). Tests inject a fake adapter, so they stay
deterministic and free.

## Boundaries (kept on purpose)

- **Manifest is authoritative.** Inputs live in the manifest, never duplicated into config.
- **Loops are step-based, not fixed roles.** A converge routine is ordered steps (`call` /
  `format` / `check`); "build"/"critique" are step ids and "builder"/"critic" participant names.
  There is no built-in implementer/reviewer slot.
- **Converge runs live, inside a sandbox.** `chit run <converge>` creates a git-worktree copy,
  runs read-write steps there, runs checks, and loops until they pass. It is a **dry run by
  default** (show the diff, discard); pass `--apply` to write a converged result back. Your real
  tree is never touched without `--apply`.
- **Two safety layers, and they are not the same strength.** A participant's `filesystem` maps to
  a claude permission mode (read-only -> `plan`, read-write -> `acceptEdits`, none -> no tools):
  that is claude-level, not an OS sandbox, and only as strong as claude's permission system.
  Converge **write safety** is the strong one and is enforced: read-write steps run inside a
  disposable git worktree, so your real tree is never changed without `--apply`.
- **Model calls and checks have a per-call timeout; the loop has a wall-time bound.** A hung call
  or check can't block a run, and a slow run is capped.
- **Receipts store inputs and the final output in plaintext** under `.chit/runs` (gitignored),
  not per-step transcripts. Whether the body should be stored by default is an open question.

## Deliberately not here

Studio, MCP tools, plan/batch, a config editor, multi-provider adapters, routine
composition, durable resume, live progress. They come back once the single loop is solid.

## Layout

```
src/manifest.ts   the source-of-truth schema + parser (one-shot | converge)
src/config.ts     thin routine config (names + manifest path + defaults)
src/routine.ts    resolve a routine: config + bound manifest + digest
src/inputs.ts     validate operator inputs
src/template.ts   {{ inputs.x }} / {{ steps.y.output }} rendering
src/proc.ts         spawn + capture with a timeout (shared by adapter & checks)
src/adapter.ts      the one model-call seam (fake for tests, claude CLI for real)
src/check-runner.ts the check seam (fake for tests, real argv spawn)
src/sandbox.ts      write-safety seam (fake for tests, real git worktree)
src/run.ts          one-shot executor -> receipt (deterministic, no IO)
src/converge.ts     converge loop executor -> iteration receipt (deterministic, no IO)
src/converge-run.ts orchestrates a converge run in a sandbox (apply-on-confirm)
src/store.ts        receipts on disk under .chit/runs (one-shot | converge)
src/views.ts        routine list / inspect / trace rendering
src/cli.ts          the four verbs
src/index.ts        the bin
```
