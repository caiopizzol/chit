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

- `{ "id", "call": "<participant>", "prompt": "..." }`  - ask a participant
- `{ "id", "format": "<template>" }`                    - assemble text
- `{ "id", "check": [{ "command", "args" }] }`          - run commands (pass/fail)
- `{ "id", "routine": "<routineId>", "inputs": {...} }` - run another routine
- `{ "id", "ask": "<question>" }`                       - pause for one operator answer, fed forward

## Derived behavior (the user never writes a policy)

- steps are `routine` steps              → **composition** (run them in order, pass outputs forward)
- `repeat` present                       → **loop** the steps until its `until` condition holds (or maxIterations)
- neither                                → **single pass**
- any `read-write` participant OR any `check` step → runs in a **git-worktree sandbox** (dry run by default; review, then `chit apply`)
- pure read-only (no writes, no checks)  → runs in your cwd, no sandbox (a single pass, OR a read-only loop)

Looping is independent of the sandbox: a loop that writes or checks runs in a worktree; a read-only loop
(e.g. draft → critique → repeat until "ship") runs in your cwd. `ask` steps are neutral and may sit in a
composition or a single-pass text routine, but not inside a sandboxed or looping routine.

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

1. A routine's steps are EITHER `routine` steps (a composition) OR call/format/check (an execution) -
   **not both**. `ask` is neutral and allowed in either. Keeps composition and execution distinct; this
   is the line that stops it becoming a graph engine.
2. `repeat` is an execution routine (not a composition) with an exit condition. `until: "checks-pass"`
   requires ≥1 `check` step (its signal); `until: { step, equals }` requires the named step to exist AND
   an explicit `maxIterations` (a judged condition has no guaranteed termination). `until: { all: [...] }`
   requires EVERY listed condition (each validated the same way) -- so a manifest can make a model review
   blocking: converge only when the checks pass AND the critic step returns "pass".
3. `output` may only name a **text-producing** step (`call`, `format`, `routine`) - never a `check` or an
   `ask` (a check produces pass/fail; an ask answer feeds later steps and is not persisted).
4. A composition calls **execution routines only** - no nested composition (so no cycles to detect).
   At most one sub-routine is **sandboxed** (writes or has checks), and it must be **last**; every earlier
   step must write nothing - a one-shot text run, an `ask` gate, or a read-only loop.
5. `{{ inputs.X }}` and `{{ steps.Y.output }}` refs are validated at resolve.
6. `ask` (human input) is allowed only in a composition or a single-pass read-only text routine - never in a
   sandboxed or looping routine (where "ask once vs every iteration" is undefined); put the gate in the
   composition that calls it. The only loop control is `repeat.until` (checks-pass or `{ step, equals }`);
   branch steps and an `ask` HALT/veto are deferred, on purpose.

## What this replaces

`policy: one-shot | converge | flow` is gone as a user concept. Internally the runtime keeps the proven
executors (single / loop / composition) - derivation just picks one. The user learns ONE shape.

## Design calls (where v2 sharpened the original sketch)

- **A. No step mixing** (rule 1). The sketch implied routine-calls could mix freely with call/check; I forbid it.
  This is the single biggest lever between "minimal" and "secret workflow engine."
- **B. Dropped `repeat.from`.** A loop re-runs ALL its steps until its `until` condition holds. `from` (run
  setup once, loop a suffix) is real but adds a sub-DSL; defer until something needs it.
- **C. `output` names a text-producing step id** (call/format/routine, not check or ask). The result is that
  step's text; a sandboxed routine always shows its diff regardless.
- **D. Sandbox if read-write participant OR any check step.** A check is arbitrary process execution and can
  write, so anything that runs commands or can edit gets the worktree boundary; only pure read-only routines
  (including a read-only loop) run in your cwd. This also fixes the gap where a read-write single-pass routine
  would edit your tree.
- **E. The loop's exit is declared, not hardcoded** (rule 2). `repeat.until` is `"checks-pass"` (every check
  passed - deterministic), `{ step, equals }` (a named step's trimmed output equals a string - a model- or
  human-judged verdict), or `{ all: [...] }` (every listed condition - e.g. checks pass AND a critic returns
  "pass", making review blocking). This makes `/goal`-style loops a routine you author, not a product feature,
  while keeping convergence checkable by real signals (checks, an evaluator's exact verdict), not hidden state.

## Acceptance (re-proven after the refactor)

- grill / plan: no repeat, read-only, text output.
- implementation-review: repeat until checks pass; read-write → sandboxed.
- feature-flow: routine steps feeding outputs forward into implementation-review, with an `ask` gate before
  the sandboxed implementation step.
- refine: a read-only loop, `until: { step: "verdict", equals: "ship" }` - runs in the cwd, no sandbox;
  proven by a real run that converged in 2 iterations when the critic returned exactly "ship".
- real dry run leaves origin untouched; `chit apply` applies only a converged diff.
