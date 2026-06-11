# Receipt aggregation reader: design note

## Goal

Give an operator one rolled-up view across many recorded runs ("how much have my
runs cost, how often do they converge, where do they fail") without reading any
prompt or model-output body. This note recommends the smallest useful reader and
the surface it should expose. It is scoped to the existing durable audit corpus;
it adds a read-only roll-up, not a new store or a new on-disk format.

## What already exists

The durable model is unchanged by this work; the reader only reads it.

- **Audit receipts** live under the state dir as one append-only event log per run:
  `audit/runs/<runId>/events.jsonl`, with content-addressed bodies in
  `audit/runs/<runId>/blobs/<sha256>`. Each line is one `AuditEvent` from a closed
  discriminated union: `run.started`, `step.started`, `adapter.call.started`,
  `adapter.event`, `adapter.call.completed`, `step.completed`, `step.failed`,
  `loop.iteration.recorded`, `run.completed`. Every event carries `runId` and an
  ISO `ts`.
- **Loops, jobs, plans, sessions** are sibling state layers under the same root.
  A loop log (`loops/<repoKey>/<loopId>.jsonl`) owns iteration detail; a job record
  (`jobs/<runId>.json`) is the durable worker state; a plan step snapshots a compact
  `LoopReceipt`. They link by `runId` (public id), `loopId` (loop log key), `scope`,
  and `auditRef` (an iteration's audit run id).
- **The per-run reader** (`apps/cli/src/audit/reader.ts`) already turns one run's
  events into a body-free `RunSummary` (`runId`, `manifestId`, `surface`, `scope`,
  `loopId`, `iteration`, `startedAt`, `status`, `stepCount`, `usage`) via
  `summarizeRun`, sums token/cost across a run via `sumUsage`, and tolerates corrupt
  logs via `safeReadEvents` (returns `[]` on any read/parse error). It also resolves
  bodies, but only behind an explicit `includeBodies` flag that is off by default.

The gap is only *cross-run*: there is no function that folds many `RunSummary`
values into one aggregate. That is the whole job.

## Corpus shape (local, aggregate only)

Measured over the local corpus to size the reader, no bodies read:

- ~809 recorded runs; surfaces are overwhelmingly `converge` with a small `mcp` tail.
- `adapter.event` rows dominate the line count by ~200x over every other event type;
  the reader must skip them, not summarize them.
- ~1,150 completed adapter calls; hundreds of `step.failed` events, so failure
  counting is worth surfacing.
- Usage sums are large (hundreds of millions of input tokens, single-digit-million
  output tokens, triple-digit-USD estimated cost), so totals must be 64-bit-safe
  numbers and cost should stay a single summed float.

The practical lesson: the bulk of bytes is `adapter.event`/blob content the reader
never needs; folding header + completion + the loop-iteration event per run is cheap.

## Recommended reader

A single pure roll-up function over the existing store, reusing the existing
per-run summarizer. No new store, no new event type, no schema change.

`aggregateReceipts(store, opts?) -> ReceiptAggregate`

- Enumerate runs with the store's existing run listing (`listRuns()` returns ids in
  arbitrary filesystem order, not sorted).
- For each run, read events with the tolerant reader and summarize with
  `summarizeRun`; never request bodies (`includeBodies` stays false), never open
  `blobs/`. A run whose log is empty/corrupt folds in as a counted skip, not a throw.
- Sort the summaries by `startedAt` descending (newest first) before applying
  `limit`, exactly as `listAudit` does; never lean on `listRuns` order for the cap.
- Fold each `RunSummary` plus the run's `loop.iteration.recorded` events into
  accumulators.

`opts` (all optional): `since`/`until` (ISO bounds on `startedAt`), `surface`
filter, `scope` filter, `limit` (cap kept after the newest-first sort).

`ReceiptAggregate` (metrics only):

- `runs`: total folded, plus `skipped` (unreadable logs).
- `bySurface`, `byStatus`: counts keyed by the low-cardinality safe enums.
- `steps`: total `stepCount`; `failedSteps`: count of `step.failed`.
- `usage`: summed `AdapterUsage` (input/output/cached/reasoning tokens, est cost).
- `convergence`: counts of loop verdicts/decisions from `loop.iteration.recorded`
  (`proceed`/`revise`/`block`) and total findings, so "how often do runs converge"
  is answerable from the audit corpus alone.
- `timeRange`: earliest/latest `startedAt` observed.

This is intentionally one read path that builds on `reader.ts`. Grouping by `scope`
or joining loop-stop status from loop logs is a deliberate non-goal for v1: scope is
a user-chosen label (treat as potentially identifying) and loop-stop status is a
second store. Both are additive later without changing this shape.

## Surface

Expose it as a read-only CLI subcommand alongside the existing audit reader (the
natural sibling of `chit audit list`), printing the aggregate as a small table with
a `--json` flag for the structured object. No MCP tool and no write path in v1.

## Privacy rules the reader enforces

- Never read `blobs/`; never set `includeBodies`. Prompts, model outputs, and raw
  adapter event bodies are addressed by `inputBlob`/`outputBlob`/`rawBlob` and are
  never touched.
- Emit only metrics and low-cardinality safe enums (`surface`, `status`, verdicts)
  and numeric sums. Never emit `cwd`, `commandArgs`, `manifestPath`, session refs, or
  `step.failed` error strings, which can carry absolute paths or private data.
- `scope` may identify work; keep it as an opt-in filter input, not a grouped output
  dimension, in v1.
- Tolerate corruption: count a skipped run rather than failing the whole aggregate.

## Suggested implementation and tests

- Implementation: `apps/cli/src/audit/aggregate.ts` (pure fold over `reader.ts`),
  wired to a new read-only subcommand in `apps/cli/src/cli/audit.ts`.
- Tests: `apps/cli/src/audit/aggregate.test.ts` covering an empty store, mixed
  surfaces/statuses, usage summation, `step.failed` counting, verdict counts from
  `loop.iteration.recorded`, `since`/`until`/`surface`/`limit` filtering, a corrupt
  log counted as skipped, and the invariant that no body/blob is ever read.
