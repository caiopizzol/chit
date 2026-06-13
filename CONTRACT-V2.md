# Routine v2: one shape

The shipped model. One file format. No `policy` field. Behavior is **derived from structure**, not chosen.

## The shape

```json
{
  "id": "...",
  "description": "...",
  "inputs":  { "<name>": { "type": "string", "required": true } },
  "participants": { "<id>": { "agent": "...", "filesystem": "read-only|read-write|none", "instructions": "..." } },
  "steps": [ ... ],
  "repeat": { "until": "checks-pass", "maxIterations": 3 },
  "output": "<stepId>",
  "limits": { "callTimeoutMinutes": 30, "runTimeoutMinutes": 120 }
}
```
`repeat`, `output`, and `limits` are optional. `participants` is omitted by a composition (it has none of its own).

## Step kinds

- `{ "id", "call": "<participant>", "prompt": "..." }`  — ask a participant
- `{ "id", "format": "<template>" }`                    — assemble text
- `{ "id", "check": [{ "command", "args" }] }`          — run commands (pass/fail)
- `{ "id", "routine": "<routineId>", "inputs": {...} }` — run another routine

## Derived behavior (the user never writes a policy)

- steps are `routine` steps              → **composition** (run them in order, pass outputs forward)
- `repeat` present                       → **loop** the steps until every check passes (or maxIterations)
- neither                                → **single pass**
- any `read-write` participant OR any `check` step → runs in a **git-worktree sandbox** (dry run by default, `--apply` writes back)
- pure read-only call/format (no checks) → runs **read-only** in your cwd (text only)

A `check` command is arbitrary process execution (`bun test`, deploy scripts) and can write files, so a
routine that runs ANY check gets the worktree boundary too -- not just one with a read-write participant.

## Limits (operator control over wall-time)

Optional. Two independent bounds in minutes, plus the loop's existing `maxIterations`:

- `callTimeoutMinutes`: kill any single model call OR check command that runs past this. Default **30**.
- `runTimeoutMinutes`: fail the whole run once its wall-time passes this -- a single pass, a loop (checked
  before each iteration), or a whole composition (checked before each sub-routine). Default **120**.

Set either to `"none"` to drop that bound. Defaults are deliberately high: the bound catches a hang or a
runaway loop, not honest slow work. `maxIterations` always applies regardless. A composition makes no direct
calls, so `callTimeoutMinutes` is not valid there -- set it on the routines it calls.

`callTimeoutMinutes` is a **hard** kill (the subprocess is terminated). `runTimeoutMinutes` is a
**cooperative** budget: a unit already running finishes under its own `callTimeoutMinutes`, and the run
stops at the next checkpoint. (Ctrl-C aborts mid-call via the cancellation signal; wiring
`runTimeoutMinutes` to that same signal, for a hard run deadline, is a possible follow-up.)

## Rules (few, enforced at resolve, with clear errors)

1. A routine's steps are EITHER all `routine` steps OR a mix of call/format/check — **not both**. Keeps
   composition and execution distinct; this is the line that stops it becoming a graph engine.
2. `repeat` requires ≥1 `check` step and an execution routine (not a composition).
3. `output` may only name a **text-producing** step (`call`, `format`, `routine`) — never a `check`
   (a check produces pass/fail, not text; its result lives in the receipt).
4. A composition calls **execution routines only** — no nested composition (so no cycles to detect).
   At most one sub-routine is sandboxed (writes or has checks), and it must be **last**; earlier
   sub-routines must be pure read-only/text.
5. `{{ inputs.X }}` and `{{ steps.Y.output }}` refs are validated at resolve.
6. No branching/conditionals beyond **repeat-until-checks** and **stop-on-failed-step**. Human gates / branch
   steps are deferred, on purpose.

## What this replaces

`policy: one-shot | converge | flow` is gone as a user concept. Internally the runtime keeps the proven
executors (single / loop / composition) — derivation just picks one. The user learns ONE shape.

## Design calls (where v2 sharpened the original sketch)

- **A. No step mixing** (rule 1). The sketch implied routine-calls could mix freely with call/check; I forbid it.
  This is the single biggest lever between "minimal" and "secret workflow engine."
- **B. Dropped `repeat.from`.** A loop re-runs ALL its steps until checks pass. `from` (run setup once, loop a
  suffix) is real but adds a sub-DSL; defer until something needs it.
- **C. `output` names a text-producing step id** (call/format/routine, not check). The result is that step's
  text; a sandboxed routine always shows its diff regardless.
- **D. Sandbox if read-write participant OR any check step.** A check is arbitrary process execution and can
  write, so anything that runs commands or can edit gets the worktree boundary; only pure read-only call/format
  routines run in your cwd. This also fixes the current gap where a read-write single-pass routine edits your tree.

## Acceptance (re-proven after the refactor)

- grill / plan: no repeat, read-only, text output.
- implementation-review: repeat until checks pass; read-write → sandboxed.
- feature-flow: routine steps feeding outputs forward into implementation-review.
- real dry run leaves origin untouched; `--apply` applies only a converged diff.
