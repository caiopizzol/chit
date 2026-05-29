# Loop view + convergence log (v0)

Spec for visualizing a supervised-convergence loop in Studio. Companion to
`docs/supervised-convergence.md` (the loop policy) and `docs/studio-v0.md` (the
editor). The manifest graph stays the primary Studio artifact; this adds a
read-only view of loop execution/decision history.

## The view (decided)

A **compact iteration rail**, opened as a right-side drawer / secondary Studio
view from a header **Loops** control. Not a peer tab of the manifest editor
(until there is navigation for that): the manifest graph is the primary
artifact; loop history is execution/decision context.

Shows:

- **Loop header**: scope, task title, status, total iterations, total elapsed.
- **Per iteration** (a vertical block telling the implement -> check -> decide story):
  - implement summary
  - changed files (count + list)
  - checks run
  - Codex verdict + finding count
  - Claude decision
- **Footer**: stop reason.

Principle: the default view answers "what happened, why did we continue or stop,
and where should I inspect?" Raw full Codex output is **not** inline; it sits
behind a per-iteration expand/details control.

```
Loop  studio-loop-viz                 [ converged ]
chit · 2 iterations · 3m 12s

 ① implement  "add convergence log writer"
              +4 files
    check     REVISE · 18s · 2 findings (1 med, 1 low)
    decide    revise
 ───────────────────────────────────────────────
 ② implement  "address findings: ownership guard"
              +2 files
    check     PROCEED · 22s · no findings
    decide    proceed
 ───────────────────────────────────────────────
 ✓ stopped: converged (proceed + task complete)
```

## The convergence log (the data that feeds the view)

- **Written by the orchestrator** (the Claude Code chat running the
  supervised-convergence skill), not derived from chit runs. chit only sees the
  `check` run; the implement and decide steps live in the chat, so only the
  orchestrator has the full loop facts. A chit run-audit would record reviews,
  not the loop.
- **Studio reads the file from disk.** It does not depend on the MCP server's
  in-memory `RunStore` (that is process-local and idle-evicted by design).
- **Location**: `.chit/loops/<loop-id>.jsonl` in the working repo (cwd). One
  file per loop. Append-only JSONL: crash-safe and tailable as the loop runs.
- **Records** (one JSON object per line):
  - `loop` (first line): `schema`, `loopId`, `scope`, `task`, `repo`,
    `startedAt`, `maxIterations`.
  - `iteration` (one per round): `n`, `implementSummary`, `changedFiles[]`,
    `checksRun`, `verdict` (`proceed|revise|block`), `findingCount`, `decision`
    (`proceed|revise|block`), `checkDurationMs`, `at`, optional `detailsRef`
    (pointer to the full check output / chit run_id).
  - `stop` (last line): `status`
    (`converged|blocked|max-iterations|needs-decision`), `reason`, `iterations`,
    `totalElapsedMs`, `endedAt`.
- Product-level facts only. No raw token logs; full Codex output stays behind
  `detailsRef`, not embedded.

## Build order

1. **Pure data model + validate/serialize/parse** in `@chit/core` (browser-safe),
   so both the writer and Studio share one contract. <- first loop slice
2. **Node-backed append/read** + a tiny `chit` writer the skill calls each
   iteration.
3. **Studio render**: a Loops drawer reading the log, the compact rail above.

## Out of scope (v0)

- Search/history across loops (the dense table is a later view).
- Embedding full Codex output inline.
- Deriving loop history from a checks-only chit run-audit (misleading: it shows
  reviews, not the loop).
