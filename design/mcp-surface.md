# chit MCP surface (v0)

The MCP surface exposes chit inside a chat through two tool families: stepwise
manifest tools (run a manifest one step at a time, with a live heartbeat on each
long step) and converge tools (drive the autonomous implement/review loop one
iteration at a time). Both are the conversational counterpart to a CLI command
that otherwise runs to completion in one shot (`chit run` and `chit converge`).

Status: validated spike, dogfooded against real claude + codex. In-session
cancel is settled (outcome a, below). Source: `apps/cli/src/surfaces/mcp/`
(`server.ts` = tools, `engine.ts` = stepwise run engine, `converge-engine.ts` =
single-iteration converge driver, `*-store.ts` = idle-evicting in-memory stores).
Register as a stdio MCP server:

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

## Converge tools

The converge tools drive the autonomous implement/review loop (`chit converge`)
one iteration at a time, so each iteration is a separate, cancellable tool call
and the loop is inspectable between calls. They sit on the SAME single-iteration
primitive (`runConvergeIteration`) and write the SAME loop log
(`.chit/loops/<loop_id>.jsonl`) as the CLI, so a loop driven over MCP is
identical on disk to one driven by `chit converge`. The loop log is the durable
state; the server keeps an idle-evicting in-memory session (the audited execute
boundary, the `prior_review` to thread forward, and the in-flight
`AbortController`) but never a second source of truth for iterations.

`describeConverge` (the loop's control-plane view, embedded as `loop` in
`chit_converge_next`/`_cancel` results) is `{ loop_id, scope, cwd, task,
max_iterations, iteration (completed), status, active, cancellable, last_verdict?,
last_decision?, failure?, audit_refs[], next_action }`, where `status` is
`open | running | converged | blocked | max-iterations | cancelled`.

### chit_converge_start
Open a loop. Inputs: `task`, `scope`, `cwd?` (defaults to server cwd; also where
the loop log is written), `manifest_path?` (default bundled `converge.json`),
`max_iterations` (default 3), `loop_id?`, `force` (overwrite an existing log),
`allow_unenforced_permissions` (default `false`). Audit is always on (the loop
records link to the audit transcript). Returns `describeConverge` (+ `warnings[]`
for unenforced permissions). Errors mirror `chit converge`: unreadable/invalid
manifest, non-converge shape, unknown agent, enforcement gap without the flag,
existing log without `force`.

### chit_converge_next
Run exactly ONE implement→review iteration, blocking until it settles; emits a
heartbeat while it runs. Input: `loop_id`. Folds the request's `extra.signal`
into the iteration's abort, so Esc (or `chit_converge_cancel`) cancels the
in-flight implement/review. A normal iteration returns `{ iteration, verdict,
decision, findingCount, checksRun, changedFiles, usage?, auditRunId?, stopStatus?,
loop }` (a set `stopStatus` means the loop also stopped: `proceed`→converged,
`block`→blocked, the budget→max-iterations; `usage` is the iteration's token/cost
when reported). A cancelled iteration returns `{ cancelled: true,
iteration, loop }` and records a clean `cancelled` stop with NO iteration record
(never a fake-successful round). A graceful manifest failure returns
`{ failed: true, iteration, failure, loop }` and closes the loop `blocked`.
Rejects (engine error) a loop that is already terminal or already has an
iteration in flight (the loop log is single-writer).

### chit_converge_status
Compact control-plane view: "what should I do next?". Input: `loop_id`. Returns
`describeConverge` from the in-memory session alone (no loop-log read), so it is
cheap to poll.

### chit_converge_cancel
Cancel a loop. Input: `loop_id`. If an iteration is in flight, aborts it (it
settles as a clean `cancelled` stop; best-effort, like `chit_cancel`); if the
loop is open but idle, closes it `cancelled` now; a terminal loop is reported
back unchanged. Returns `{ cancel: { state: cancelling | closed | already }, loop }`.

### chit_converge_trace
Diagnostic history: "what happened?". Input: `loop_id`. Reads straight from the
durable loop log (NOT a second source of truth) and adds the live state. Returns
`{ loop_id, status, active, audit_refs[], records[] }`, where `records` are the
loop-log records (header, each iteration's summary/changed files/verdict/decision/
usage/audit ref, and the stop record).

## Audit tools

Read the local audit transcripts (`chit converge`, `chit run --audit`, MCP
`chit_start audit:true`, MCP converge) from the chat. Same reader as the CLI
`chit audit list/show` (the pure logic lives in `apps/cli/src/audit/reader.ts`,
shared by both surfaces). Read-only over `~/.local/state/chit/audit`. A run with
no `run.completed` is `incomplete`, with the reason derived from the timeline (an
open call killed mid-flight, a failed step, or an abandoned run). Bodies are
resolved ONLY from blob refs a run's own events carry (`inputBlob`/`outputBlob`/
`rawBlob`), never a caller path, so the tools cannot serve an arbitrary file.

### chit_audit_list
List audited runs, newest first. Input: `limit?`. Returns `{ runs[] }`, each
`{ runId, manifestId, surface, scope?, loopId?, iteration?, startedAt?, status,
stepCount, usage?, openCall? }`. `status` is the `run.completed` status or
`incomplete`; `openCall` (when present) names a step whose adapter call started
but never completed (the killed-mid-call signal). Robust to a corrupt run log: it
is summarized as incomplete rather than failing the whole list.

### chit_audit_show
Show one run. Inputs: `run_id`, `include_bodies` (default false). Returns
`{ summary, incompleteReason?, participants?, timeline[] }`: the summary above,
the reason when incomplete, the participant config recorded at `run.started`, and
the structured event timeline. Prompt/output/event bodies attach to their
timeline entries (`input`/`output`/`raw`) only when `include_bodies` is true (they
can be large or hold secrets). Errors on an invalid or missing run id.

## Observability (heartbeat)

While a call step runs, `chit_run_step` emits, every ~5s, both a progress
notification (with `progressToken`) and a logging notification carrying the same
latest-state text: `"<step> · <participant> (<agent>) still running · Ns
elapsed"`. Claude Code renders the latest heartbeat live in the collapsed tool
call (verified); the full transcript is `chit_trace`. There is no
within-step streaming of the agent's output to the MCP client: the heartbeat is
latest-state text, not a token stream, and `chit_run_step` returns only the
step's final output. On an audited run the adapter does capture the agent's live
event stream as `adapter.event` records, but that feeds the audit log, not the
MCP client.

## Cancellation

Cancellation has two reachable paths: the explicit, portable `chit_cancel`, and
(in Claude Code) the Esc key, which propagates request cancellation (settled
below). `chit_run_step` owns an `AbortController` per run+step, registered for
the whole call, and folds in the request's own `extra.signal` (a propagated
client cancellation aborts the same controller). `chit_cancel`
aborts it; both adapters (`claude-cli`, `codex-exec`) kill their child process on
abort and reject; the engine discriminates on `signal.aborted` to settle the
step `cancelled`. The mechanism is proven end-to-end against real codex (a
concurrent `chit_cancel` killed an in-flight step in ~6s, not the ~220s it would
have taken).

## In-session cancel: settled (outcome a)

In-session cancel is reachable. Because `chit_run_step` blocks the model's turn,
in-session cancel rides on the Esc key; a live probe in Claude Code (start a long
codex step, press Esc after the first heartbeat) settled it as outcome (a): Esc
propagates MCP request cancellation. The interrupt freed the turn AND the
folded-in `extra.signal` aborted the step's controller, killing the codex child
and settling the step `cancelled` ("aborted by client") in ~5.4s, with no
`chit_cancel` call at all. (Observed via `chit_trace`; that probe run was not
audited, so this is the observed trace, not a reopenable receipt.)

This is a Claude Code behavior, not a guarantee for every MCP client, so
`chit_cancel` stays the portable, programmatic path (and the only one when the
turn is not blocked, e.g. cancelling from a fresh turn). No async-dispatch
contract change is needed: a blocking tool can stay blocking as long as it folds
the request's `extra.signal` into its active abort controller the way
`chit_run_step` does. `chit_converge_next` follows exactly this contract: it
folds `extra.signal` into the iteration's abort, and a cancelled iteration
records a clean `cancelled` stop (no iteration record) rather than a
fake-successful round.

## Known limits / backlog

- Runs live in an in-memory store (`run-store.ts`); a server restart/reconnect
  loses them. The store is idle-evicting: a run untouched for > 1h is dropped on
  the next `chit_start` sweep, unless it still has a `running` step (those are
  never evicted). Cleanup is opportunistic, so memory is bounded by future
  starts, not by wall-clock alone.
- `inputs` are string→string; `file[]` inputs are not expressible via MCP.
- Concurrent `per_scope` steps would hit the session store's read-modify-write
  race (`research/backlog.md`).
- No within-step agent-output streaming to the MCP client (heartbeat is latest-state text; the adapter's live event capture feeds the audit log, not the client).

## What is deliberately NOT next

MCP client-facing output streaming (a live token stream to the client). The
heartbeat is good enough for v0; the larger risk now is product/contract drift,
so this spec captures the contract before more features accrete. Client-facing
streaming is reconsidered only after the open question above is settled. (Live
adapter event capture for the audit log has since shipped; it is separate from
streaming output to the MCP client.)
