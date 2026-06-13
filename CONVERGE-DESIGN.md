# Converge — as built, and the one slice still missing

This supersedes an earlier draft that put fixed `implementer`/`reviewer` slots in
the loop. That was wrong: it re-introduced the fixed-role vocabulary the product
model is trying to demote. The loop is now **step-based**.

## What was built (increment 2)

A converge routine is **ordered steps**, exactly like one-shot. The only differences
are termination and an extra step kind:

- step kinds: `call` (participant + prompt), `format` (assemble text), `check` (run commands).
- a converge routine **must declare >= 1 check step** - that is its convergence signal.
- the executor runs the steps **repeatedly** until every check step passes, or `maxIterations`
  (config default -> manifest -> 5, hard ceiling 20).
- **no fixed roles.** `build`/`critique` are step ids; `builder`/`critic` are participant names.
  You define who calls what, with which prompt, in what order, and which checks gate it.

State threads across iterations through a persistent, pre-seeded context:
- `{{ iteration }}` - the 1-based iteration number.
- `{{ steps.<id>.output }}` - a step's output; for a check step this is its **combined failing
  output**, so the next iteration's call step can read the failures and react. That feedback IS the loop.
- on iteration 1 a cross-iteration reference renders empty (pre-seeded); a typo'd step id still throws.

Receipts are a tagged union by `policy`. A `ConvergeReceipt` carries per-iteration step
statuses and per-check pass/fail, never model transcripts. `trace` renders both shapes.

Proven by `converge.test.ts`: checks fail on iteration 1 -> failure fed forward -> implementer
sees it on iteration 2 -> checks pass -> `converged`. Plus `did-not-converge` (bounded) and
`failed` (a thrown call). All fake-backed, deterministic, no real calls.

## The one slice still missing: write-safety, then live execution

Live `chit run <converge>` still refuses, on purpose. A meaningful converge loop needs the
build step to **edit files** (so checks change between iterations) - and a read-write step
editing the real cwd in a loop, unsandboxed, is the exact thing prior reviews said not to do.

Next slice:
1. **Sandbox.** Run the loop in a throwaway copy / git worktree of the cwd, so the original is
   never touched. Show the resulting diff at the end; apply only on explicit confirm.
2. **A real editing adapter.** The current `claude -p` adapter does not grant edit permissions.
   Real converge needs an adapter that can edit within the sandbox, plus a way to surface "what
   changed" to the reviewer (a real diff, replacing the text-only `{{ steps.build.output }}` the
   fake prototype reviews).
3. Then lift the `cli.ts` converge gate.

Until that lands, converge is fully **configurable and inspectable**, its loop logic is **proven**,
but it does not run against your real files from the CLI.
