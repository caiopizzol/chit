# Converge - as built, and the one slice still missing

> **Historical design journal (increments 2-3).** It is accurate for *when it was written*, but the
> model has since moved on. For the current contract see `CONTRACT-V2.md` and `STATE.md`. Notably superseded
> here: a loop no longer requires a check step - `repeat.until` is `"checks-pass"` OR `{ step, equals }`, and
> a read-only loop runs in the cwd, not a sandbox (increment 21); the read-only permission mapping is no
> longer `--permission-mode plan` (that returned empty under `-p`) but default mode with edit tools disallowed.

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

## Write-safety + live execution: DONE (increment 3)

Live `chit run <converge>` now runs, safely:
1. **Sandbox** (`sandbox.ts`): a git worktree of the cwd (node_modules symlinked). Read-write steps
   edit the copy; the original is never touched. `diff` / `apply` / `discard` via git.
2. **Permission-aware adapter**: `claude -p --permission-mode acceptEdits` for read-write steps
   (in the sandbox cwd), `plan` for read-only. A `{{ diff }}` template var + `diffProvider` give
   review steps the real sandbox diff.
3. **Apply-on-confirm** (`converge-run.ts`): dry run by default (show the diff, discard); `--apply`
   writes a converged result back. A run that did not converge is never applied.

Proven by a real end-to-end smoke (`sandbox-smoke`): real claude created a file in the sandbox, a
real `grep` check passed, the loop converged, the diff was shown, and the origin was left untouched.

## The next slice: routine composition

End-to-end orchestration is more than one loop: `grill -> plan -> implementation-review -> ...`.
Today each routine is standalone. Next is letting one routine call another and pass artifacts
forward. Everything after that (durable resume, live progress/pause, budgets/timeouts, richer
evidence in receipts, parallel fan-out) is deliberately later - none of it blocks the single loop.
