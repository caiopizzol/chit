# chit audit log (v0)

The audit log is the durable record of a run. When a run is audited, chit writes
one append-only event log plus the full prompts and outputs, so you can read back
what each agent was asked and what it returned, with token usage and timing, after
the run is over. It is the receipt layer: which agent, with what input, what
output, in what order. The bodies are kept too, but they are opt-in to read.

Status: shipped are the event schema (`@chit/core`), the node store, audit on all
three run surfaces, retention, the `chit audit` reader, the Studio audit view
(open a run from a loop's detailsRef in the Loops drawer), and preservation of
both adapters' observable event streams as `adapter.event` records on audited
runs: the raw JSONL Codex emits, and the Claude stream-json stream (system,
stream_event deltas, assistant, result) - tool events, command executions, and
reasoning summaries the CLIs emit. Note: events are preserved after the call
completes (the adapters buffer stdout), not live per-event, and never hidden
model reasoning.
Source: `packages/core/src/audit/events.ts` (schema),
`apps/cli/src/audit/` (store, recorder, wrapper), `apps/cli/src/cli/audit.ts`
(reader).

## What it captures

Each audited run is a directory under the local state dir:

```text
~/.local/state/handoff/audit/runs/<runId>/
  events.jsonl        append-only, one event per line
  blobs/<sha256>      content-addressed bodies (prompts, outputs, raw events)
```

The events are a run timeline: `run.started`, then per step `step.started` and
`step.completed` (or `step.failed`), per agent call `adapter.call.started` and
`adapter.call.completed`, an `adapter.event` for each raw event the adapter
surfaced during the call (Codex JSONL today), and finally `run.completed`. Large
bodies are not inlined. A rendered prompt, a step output, an agent's returned
text, and each raw event body are written to `blobs/` and referenced by their
sha256, so the same content is stored once. Every step's output is captured,
including format steps that have no agent call, so a run can be read back in full.

`adapter.call.completed` carries token usage when the CLI reports it. claude
reports input/output/cache tokens and a cost. codex reports tokens and no cost, so
a summed cost is a known floor, not a guaranteed total. Token counts across
providers are a volume signal, not one billing unit.

## When a run is audited

Audit is opt-in everywhere except the autonomous loop, because the bodies can hold
secrets (see Sensitivity).

- `chit converge` audits by default. Each iteration's run is recorded, and the
  loop iteration links to it through the loop log's `detailsRef`.
- `chit run --audit` records one run. The run id is printed on stderr.
- The MCP surface records a run when `chit_start` is called with `audit: true`. The
  audit run reuses the MCP `run_id`.

A run with no `run.completed` event is INCOMPLETE: it failed, was cancelled, or was
abandoned. The reader never treats a missing terminal event as success.

## Reading the log

```text
chit audit list
chit audit show <runId>
```

`list` prints the runs, newest first, with status and a usage summary. `show`
prints one run's timeline and a usage summary. Both take `--json`. `show` takes
`--blobs` (alias `--include-bodies`) to print the blob bodies (rendered prompts,
outputs, and raw adapter event bodies); without it, only the event timeline is
shown.

```text
chit audit show 9b41-...

run 9b41-...
  manifest: converge   surface: converge   scope: audit-cli
  started: 2026-05-31T10:00:00.000Z
  status: ok
  tokens: in 22232, out 66, cached 21788, reasoning 19; reported cost: $0.0658

timeline:
  run.started   manifest=converge surface=converge scope=audit-cli
  step.started  implement (call) implementer/claude-cli
  adapter.call.started  implement implementer/claude-cli
  adapter.call.completed  implement ok 41200ms  tokens: in 6590, out 40; reported cost: $0.0658
  step.completed  implement 41250ms
  ...
  run.completed  ok 95000ms
```

## Retention

Audit transcripts accumulate, so each audited run prunes the store after it
finishes. The defaults keep:

- runs newer than 30 days,
- the newest 1000 runs,
- the newest runs whose total size fits under 1 GiB.

A run is removed if it exceeds any cap. Pruning runs only at a terminal point,
after the run is fully written, and never removes the run that just finished.
Pruning is best-effort: a prune failure never fails the run and never affects
whether the run was recorded.

Retention does not redact. It bounds how much is kept, not what each kept run
contains.

## Sensitivity

Audit blobs hold the full rendered prompts and full agent outputs. Those can
contain source code, file contents, credentials, and anything else that flowed
through the run. Treat the audit store as sensitive:

- It lives under your local state dir, readable by anything with access to your
  account. It is not encrypted.
- Do not commit it, and do not share a transcript without reading what is in it.
  `chit audit show <runId> --blobs` prints exactly what would be shared.
- Plain `chit run` and MCP runs do not audit unless you ask. `chit converge`
  audits by default because the loop log already points at the transcript.
