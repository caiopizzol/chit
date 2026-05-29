# chit MCP surface (v0)

The MCP surface exposes a chit run as a set of stepwise tools, so a model (and
the human watching it) can run a manifest one step at a time inside a chat,
with a live heartbeat on each long step. It is the conversational counterpart to
the CLI `chit run` (which runs the whole DAG to completion in one shot).

Status: validated spike, dogfooded against real claude + codex (receipts 0004,
0005). One open UX question remains (in-session cancel reachability, below); it
is not a correctness gap. Source: `apps/cli/src/surfaces/mcp/` (`server.ts` =
tools, `engine.ts` = stepwise run engine). Register as a stdio MCP server:

```sh
claude mcp add chit --scope local -- bun <repo>/apps/cli/src/surfaces/mcp/server.ts
```

## Execution model

A run is a stepwise projection of a manifest DAG. chit, not the model, decides
what is legal to run next.

- **chit owns the order.** A step is *ready* only when every step in its
  `manifest.dependencies` is `done`. `chit_run_step` rejects anything else
  ("not ready; waiting on: X"). The model drives, but it cannot invent routing
  (no dynamic, model-decided handoffs — the static-DAG thesis holds).
- **A step runs exactly once.** `chit_run_step` marks the record `running`
  synchronously before the first await, so a concurrent call on the same step
  is rejected ("already running"). On settle the record is terminal:
  `done` | `failed` | `cancelled`. Re-running a terminal step is refused.
- **Completion is all-steps-done**, not just the output step: an independent
  pending/failed branch keeps the run incomplete.
- **`chit_run_step` blocks** until its step settles. The heartbeat renders on
  that in-flight tool call. (Consequence: a model turn is pinned for the step's
  whole duration — see the open question.)
- **Sessions.** `per_scope` participants need a `scope`; `chit_start` rejects a
  `per_scope` manifest started without one rather than silently running
  stateless. Within a run, a `per_scope` participant resumes its own session
  across steps (proven: a later step references its own earlier output without
  it being re-passed).

## Tools

All results are JSON in a single text block. `describeRun` (embedded in most
results) is `{ run_id, manifest, complete, ready[], output? }`, where each
`ready` entry is `{ step, kind, participant?, agent?, session? }` and `output`
is the final output (present only when `complete`).

### chit_start
Start a run. Inputs: `manifest_path` (abs, or relative to cwd), `inputs`
(string→string map, default `{}`), `scope?`, `cwd?` (passed to agents; defaults
to the server cwd), `allow_unenforced_permissions` (default `true`). Returns
`describeRun` with the initial ready set. Errors: unreadable/invalid manifest,
unknown agent, enforcement gap without the flag, `per_scope` without `scope`.

### chit_next
List the steps ready to run next (or report completion). Input: `run_id`.
Returns `describeRun`.

### chit_run_step
Run one ready step, blocking until it settles; emits a heartbeat while it runs.
Inputs: `run_id`, `step_id`. On success returns
`{ ran, durationMs, step_output, ...describeRun }`. On cancellation returns
`{ cancelled: true, step, durationMs, ...describeRun }` (a clean result, not an
error). Rejects out-of-order, duplicate-running, or terminal steps.

### chit_cancel
Cancel a step that is currently running. Inputs: `run_id`, `step_id`. Aborts the
step's registered controller → the adapter kills the agent's child process → the
step settles `cancelled` (terminal, blocks dependents). Returns
`{ step, cancelled, reason?, ...describeRun }` where `cancelled` is `true` if it
stopped a running step, else `reason` is `already_done` or `not_running`.

### chit_trace
The transcript so far. Input: `run_id`. Returns
`{ run_id, manifest, complete, trace[] }`, each trace entry
`{ step, kind, participant, agent, status, durationMs, output, error }`.

## Observability (heartbeat)

While a call step runs, `chit_run_step` emits, every ~5s, both a progress
notification (with `progressToken`) and a logging notification carrying the same
latest-state text: `"<step> · <participant> (<agent>) still running · Ns
elapsed"`. Claude Code renders the latest heartbeat live in the collapsed tool
call (verified, receipt 0004); the full transcript is `chit_trace`. There is no
within-step streaming of the agent's own intermediate output (the adapter keeps
only the final answer) — latest-state text, not a token stream.

## Cancellation

Cancellation is an explicit chit action, not a dependency on ambient Esc
behavior. `chit_run_step` owns an `AbortController` per run+step, registered for
the whole call, and folds in the request's own `extra.signal` (so if a client
cancellation ever propagates, it aborts the same controller). `chit_cancel`
aborts it; both adapters (`claude-cli`, `codex-exec`) kill their child process on
abort and reject; the engine discriminates on `signal.aborted` to settle the
step `cancelled`. The mechanism is proven end-to-end against real codex (a
concurrent `chit_cancel` killed an in-flight step in ~6s, not the ~220s it would
have taken — receipt 0005).

## Open question (UX, not correctness)

In-session cancel reachability is unproven: because `chit_run_step` blocks the
model's turn, issuing a `chit_cancel` while a step is in flight depends on
pressing **Esc** to free the turn. Three outcomes, to be settled by a cheap live
probe (start a long step, Esc after the first heartbeat, record what happens):

- (a) Esc propagates MCP cancellation → the folded-in `extra.signal` cancels the
  step with no `chit_cancel` call at all.
- (b) Esc frees the turn but does not cancel → a follow-up `chit_cancel` reaches
  the still-registered controller (server-side path proven by 0005).
- (c) Esc neither cancels nor frees the turn → in-session cancel is unreachable,
  which would justify converting `chit_run_step` to async dispatch (returns
  immediately; poll `chit_next`/a `chit_status`; `chit_cancel` in a normal
  turn). That is a contract-breaking slice, not a tweak — deferred until (c) is
  actually observed.

## Known limits / backlog

- Runs live in an in-memory store (`run-store.ts`); a server restart/reconnect
  loses them. The store is idle-evicting: a run untouched for > 1h is dropped on
  the next `chit_start` sweep, unless it still has a `running` step (those are
  never evicted). Cleanup is opportunistic, so memory is bounded by future
  starts, not by wall-clock alone.
- `inputs` are string→string; `file[]` inputs are not expressible via MCP.
- Concurrent `per_scope` steps would hit the session store's read-modify-write
  race (`docs/backlog.md`).
- No within-step agent-output streaming (heartbeat is latest-state text).

## What is deliberately NOT next

Richer adapter event-streaming. The heartbeat is good enough for v0; the larger
risk now is product/contract drift, so this spec captures the contract before
more features accrete. Streaming is reconsidered only after the open question
above is settled.
