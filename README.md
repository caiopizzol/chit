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
- **Converge is inspect-only.** You can list and inspect a converge routine; running its
  loop (and the digest/drift safety that guards it) is the hardened runtime's job, not this proof's.
- **Filesystem permissions are requested, not enforced.** A participant's `filesystem` is
  shown and passed to the adapter, but nothing sandboxes the model. A "read-only" routine is
  read-only because it was *instructed* to be, not because chit-minimal stops a write.
- **Receipts store inputs and the final output in plaintext** under `.chit/runs` (gitignored),
  not per-step transcripts. Whether the body should be stored by default is an open question.

## Deliberately not here

Studio, MCP tools, plan/batch, a config editor, multi-provider adapters,
converge execution. They come back only once this read-and-run loop feels obvious.

## Layout

```
src/manifest.ts   the source-of-truth schema + parser (one-shot | converge)
src/config.ts     thin routine config (names + manifest path + defaults)
src/routine.ts    resolve a routine: config + bound manifest + digest
src/inputs.ts     validate operator inputs
src/template.ts   {{ inputs.x }} / {{ steps.y.output }} rendering
src/adapter.ts    the one model-call seam (fake for tests, claude CLI for real)
src/run.ts        one-shot executor -> receipt (deterministic, no IO)
src/store.ts      receipts on disk under .chit/runs
src/views.ts      routine list / inspect / trace rendering
src/cli.ts        the four verbs
src/index.ts      the bin
```
