# chit-minimal

A from-scratch proof of one idea: **a routine is a declared workflow.** Chit can
**list** it, **inspect** it, **run** it, and show **what happened**. CLI only.

It reuses Chit's *concepts* (routines, agents, receipts, content digests) but
shares no code with the main runtime, so the product shape can be judged on its own.

## The model

One shape. You describe the work; **how it runs is derived**, never chosen.

- A **routine** is the one concept you configure: a declared workflow, usually inline in
  `chit.config.json`, extractable to a file when it grows.
- **Profiles** are local adapter/model bindings, e.g. `"builder": "codex:gpt-5.5"`.
- **Routine agents** are the actors inside one routine. Each points at a profile and
  declares instructions plus filesystem permission.
- **Steps** are `call` (ask a routine agent), `format` (assemble text), `check` (run a
  command), `routine` (run another routine), or `ask` (pause for one operator answer,
  fed forward like any step output). "build"/"critique" are just step ids,
  "builder"/"critic" just participant names -- there is no built-in implementer/reviewer.
- **An `ask` step is a human-input gate.** It pauses, asks the operator one question
  (which can template in earlier output, e.g. "approve this plan: {{ steps.plan.output }}"),
  and feeds the typed answer to later steps. The ask step does not record the answer on its own
  receipt, but a forwarded answer is persisted like any other value once it flows into a
  sub-routine's input or a run's output (receipts store those in plaintext). Gates belong in
  text routines or compositions (where execution pauses cleanly between steps), not inside a
  sandboxed/looping routine; put the gate in the composition that calls it instead.
- **Profiles are bound in config, not baked in.** You define your own builder, critic,
  planner, etc., and point each at the adapter/model you want, without Chit knowing those roles.
- **Behavior is derived from the shape -- there is no `policy` field:**

```
routine steps                              -> composition  (run them, pass outputs forward)
a repeat                                   -> loop         (until its `until` condition holds)
a read-write participant OR any check step -> sandboxed    (runs in a git-worktree copy)
pure read-only call/format, no checks      -> text         (runs in your cwd)
```

- **The loop's exit condition is yours to declare, so `/goal` is a routine, not a feature.**
  `repeat.until` is `"checks-pass"` (every check command passed -- deterministic, the default),
  `{ step, equals }` (a named step's output equals a string, e.g. an evaluator returns `"yes"`),
  or `{ all: [...] }` (every listed condition -- so a critic can BLOCK convergence: checks pass
  AND the critic returns `"pass"`). A judged condition needs an explicit `maxIterations`. Looping
  is independent of the sandbox: a writing/checking loop runs in a worktree; a pure read-only
  loop (draft -> critique -> repeat) runs in the cwd.

```
chit init [<name>]                 scaffold a runnable routine (--template text | loop | check)
chit routines                      list declared routines (with their derived kind)
chit inspect <routine>             what it needs and what will run
chit doctor [--real]               check the environment is ready; --real makes tiny model calls
chit run <routine> [--input k=v]   run it (sandboxed = dry run); chit apply <run-id> to keep it
chit trace <run-id>                the receipt for a past run
```

## Quickstart

```bash
bun install                                      # from the repo root: set up the workspace

cd packages/cli                                  # the example routines and config live here
bun run src/index.ts doctor                      # check the environment is ready
bun run src/index.ts routines
bun run src/index.ts inspect feature-griller
bun run src/index.ts run feature-griller --input idea="add dark mode"
bun run src/index.ts trace <run-id>
bun test                                         # fast, all fake-backed (no real model calls)
```

To use chit in your own project, link the bin once, then call it from there:

```bash
cd packages/cli && bun link                      # register the chit bin (once)

cd /path/to/your-project
bun link chit-minimal                            # link chit into your project
bunx chit doctor                                 # check the environment, from your repo
```

`run` executes for real by shelling out to an already-installed CLI - `claude`, `gemini`, or `codex`,
picked per agent in config (no API keys, no HTTP). Tests inject fakes, so they stay deterministic and free.

## Boundaries (kept on purpose)

- **The routine is authoritative.** Inputs, agents, steps, repeat, and limits live in the
  routine. The routine can be inline in config or extracted with `{ "file": "routines/name.json" }`.
- **No fixed roles.** A looping routine is ordered steps (`call` / `check`); the roles are just
  step and participant names you choose.
- **Sandboxed routines run live, safely.** A routine that writes or runs checks executes inside a
  git-worktree copy (looping if it has a `repeat`). It is a **dry run by default** (show the diff,
  discard); review it, then `chit apply <run-id>` writes it back (`--auto-apply` skips the review). Your tree is never touched without one of those.
- **Two safety layers, not equal strength.** A participant's `filesystem` maps to how the claude CLI is
  invoked (read-only -> default mode with every write tool disallowed -- the edit tools AND the shell, so
  it inspects and answers but cannot write; read-write -> `acceptEdits`; none -> no tools): claude-level,
  not an OS sandbox. The strong, enforced one is the worktree: a sandboxed routine cannot reach your tree
  until you apply. A `check` is arbitrary process execution, so any routine with a check is sandboxed too.
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

A scheduler, hosted service, dynamic routing, visual config editor, or durable resume.
They can come later if the config model proves them out. Adapter support is in:
claude, gemini, and codex, each picked per agent in config.

## Layout

```
src/manifest.ts     the one routine shape: parser + behavior derivation (no policy field)
src/config.ts       authoring config: profiles, inline routines, file-backed routines
src/routine.ts      resolve a routine: config + bound manifest + digest
src/inputs.ts       validate operator inputs
src/template.ts     {{ inputs.x }} / {{ steps.y.output }} / {{ iteration }} / {{ diff }}
src/proc.ts         spawn + capture with a timeout (shared by adapter & checks)
src/adapter.ts      the one model-call seam (fake for tests; claude / gemini / codex CLIs for real)
src/check-runner.ts the check seam (fake for tests, real argv spawn)
src/sandbox.ts      write-safety seam (fake for tests, real git worktree)
src/run.ts          the text execution path (read-only, in cwd) -> receipt
src/converge.ts     the sandboxed execution loop -> iteration receipt
src/converge-run.ts orchestrates a sandboxed run in a worktree (apply-on-confirm)
src/flow.ts         composition: run sub-routines in order, pass outputs forward
src/store.ts        receipts on disk under .chit/runs (internal per-kind tag)
src/views.ts        routine list / inspect / trace rendering
src/doctor.ts       `chit doctor`: environment readiness (CLI presence, git, check commands)
src/scaffold.ts     `chit init` templates: write a runnable inline routine + register it
src/cli.ts          the verbs: init / routines / inspect / doctor / run / trace / cleanup
src/index.ts        the bin
```

The module names (`run` / `converge` / `flow`) are internal executor paths the dispatch picks from;
they are not user concepts. The user only ever writes the one manifest shape above.
