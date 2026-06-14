# chit-minimal

A from-scratch proof of one idea: **a routine is a declared workflow.** Chit can
**list** it, **inspect** it, **run** it, and show **what happened**. CLI only.

It reuses Chit's *concepts* (manifests, participants, receipts, content digests) but
shares no code with the main runtime, so the product shape can be judged on its own.

## The model

One shape. You describe the work; **how it runs is derived**, never chosen.

- A **routine** is the one concept you configure: a name pointing at a manifest.
- A **manifest** is the source of truth: inputs, participants, ordered steps, an
  optional `repeat`, and optional `limits` (time bounds). Config never restates any of this.
- **Steps** are `call` (ask a participant), `format` (assemble text), `check` (run a
  command), or `routine` (run another routine). "build"/"critique" are just step ids,
  "builder"/"critic" just participant names -- there is no built-in implementer/reviewer.
- **Behavior is derived from the shape -- there is no `policy` field:**

```
routine steps                              -> composition  (run them, pass outputs forward)
a repeat                                   -> loop         (until every check passes)
a read-write participant OR any check step -> sandboxed    (runs in a git-worktree copy)
pure read-only call/format, no checks      -> text         (runs in your cwd)
```

```
chit init [<name>]                 scaffold a runnable routine (--template text | loop | check)
chit routines                      list declared routines (with their derived kind)
chit inspect <routine>             what it needs and what will run
chit run <routine> [--input k=v]   run it; --apply to keep a sandboxed result
chit trace <run-id>                the receipt for a past run
```

## Quickstart

```bash
bun install                       # only needed for `bun run typecheck`
bun run src/index.ts init my-review            # scaffold a runnable routine + config
bun run src/index.ts routines
bun run src/index.ts inspect feature-griller
bun run src/index.ts run feature-griller --input idea="add dark mode"
bun run src/index.ts trace <run-id>
bun test                          # fast, all fake-backed (no real model calls)
```

`run` executes for real by shelling out to the `claude` CLI (already on your
machine, no API keys, no HTTP). Tests inject fakes, so they stay deterministic and free.

## Boundaries (kept on purpose)

- **Manifest is authoritative.** Inputs live in the manifest, never duplicated into config.
- **No fixed roles.** A looping routine is ordered steps (`call` / `check`); the roles are just
  step and participant names you choose.
- **Sandboxed routines run live, safely.** A routine that writes or runs checks executes inside a
  git-worktree copy (looping if it has a `repeat`). It is a **dry run by default** (show the diff,
  discard); `--apply` writes the result back. Your real tree is never touched without `--apply`.
- **Two safety layers, not equal strength.** A participant's `filesystem` maps to how the claude CLI is
  invoked (read-only -> default mode with the edit tools disallowed, so it inspects and answers but cannot
  edit; read-write -> `acceptEdits`; none -> no tools): claude-level, not an OS sandbox. The strong,
  enforced one is the worktree: a sandboxed routine cannot reach your tree without `--apply`. A `check` is
  arbitrary process execution, so any routine with a check is sandboxed too.
- **Time bounds are configurable per routine (`limits`).** `callTimeoutMinutes` (default 30) is a hard
  bound on any single model call or check -- the subprocess is killed once it is exceeded.
  `runTimeoutMinutes` (default 120) is a cooperative run budget: it is checked before each step, loop
  iteration, and sub-routine, so a run stops once it is over budget, though a call already in flight still
  finishes under its own `callTimeoutMinutes`. Set either to `"none"` to opt out; defaults are high on
  purpose, to catch a hang, not honest slow work. A composition takes only `runTimeoutMinutes`.
- **Ctrl-C cancels cleanly.** A SIGINT stops the active call or check, stops the run at the next step,
  discards any sandbox (no leftover worktree), writes a `cancelled` receipt, and exits 130. A second
  Ctrl-C force-exits.
- **Receipts store inputs and the final output in plaintext** under `.chit/runs` (gitignored),
  not per-step transcripts. Whether the body should be stored by default is an open question.

## Deliberately not here

Studio, MCP tools, plan/batch, a config editor, multi-provider adapters, durable resume.
They come back once the one-shape model feels obvious.

## Layout

```
src/manifest.ts     the one routine shape: parser + behavior derivation (no policy field)
src/config.ts       thin routine config (names + manifest path + optional defaults)
src/routine.ts      resolve a routine: config + bound manifest + digest
src/inputs.ts       validate operator inputs
src/template.ts     {{ inputs.x }} / {{ steps.y.output }} / {{ iteration }} / {{ diff }}
src/proc.ts         spawn + capture with a timeout (shared by adapter & checks)
src/adapter.ts      the one model-call seam (fake for tests, claude CLI for real)
src/check-runner.ts the check seam (fake for tests, real argv spawn)
src/sandbox.ts      write-safety seam (fake for tests, real git worktree)
src/run.ts          the text execution path (read-only, in cwd) -> receipt
src/converge.ts     the sandboxed execution loop -> iteration receipt
src/converge-run.ts orchestrates a sandboxed run in a worktree (apply-on-confirm)
src/flow.ts         composition: run sub-routines in order, pass outputs forward
src/store.ts        receipts on disk under .chit/runs (internal per-kind tag)
src/views.ts        routine list / inspect / trace rendering
src/scaffold.ts     `chit init` templates: write a runnable routine + register it
src/cli.ts          the verbs: init / routines / inspect / run / trace / cleanup
src/index.ts        the bin
```

The module names (`run` / `converge` / `flow`) are internal executor paths the dispatch picks from;
they are not user concepts. The user only ever writes the one manifest shape above.
