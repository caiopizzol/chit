# 0004 stepwise chit MCP spike (in Claude Code)

- date: 2026-05-29
- surface: chit MCP server (`apps/cli/src/surfaces/mcp/`), registered in Claude Code as `chit`
- manifest: `dogfood/propose-verify-revise.json`
- agents: claude 2.1.x (cmux binary), codex 0.134.0
- driver: the assistant called the tools; the user observed the UI
- result: pass. Stepwise + live heartbeat renders materially better than the one-shot skill.

## What ran

`chit_start` (ready=[propose]) → `chit_run_step propose` (57s) → `verify` (221s)
→ `revise` (83s) → `out` (0s) → `chit_trace`. Task was a real one: "propose the
highest-value next improvement to the MCP spike."

## What the spike proved

- **Live heartbeat renders.** During the 221s codex `verify` step, the collapsed
  tool-call line showed `verify · verifier (codex) still running · 45s elapsed`,
  updating with elapsed time. The skill's equivalent step sat silent ~164s. This
  is the "is it alive?" fix, confirmed in the real UI. Claude Code progressive
  disclosure fits the design: collapsed = latest heartbeat, ctrl+o = the call,
  ctrl+e "show all" = full detail (where a transcript / chit_trace belongs).
- **DAG guardrail held.** Only ready steps were ever offered; chit advanced the
  ready set propose→verify→revise→out; out-of-order steps are rejected by the
  engine (verified headless earlier). The model drove; chit decided legality.
- **per_scope resume within the run.** revise retracted its own proposal phrasings
  ("'chit owns control' was my paraphrase", "the retry claim was false") that
  were NOT in the revise prompt.
- **The handoff is substantive.** Codex's verify produced 9 file:line-cited
  findings on the proposal; revise accepted them and produced a better design.

## Bonus: the run reviewed the spike's own code and found a real bug

Because the task pointed at `apps/cli/src/surfaces/mcp/`, Codex's review caught a
genuine concurrency hole I wrote: `chit_run_step` has no in-progress lock, so a
step stays `pending` through its whole adapter call (`engine.ts` sets status only
after success/failure), meaning two `chit_run_step` calls on the same step both
pass the `done` guard and both spawn. Independent of cancellation, worth fixing.

It also argued cancellation > streaming as the next bet: chit governs what may
*start* but cannot *stop* a running step (Esc orphans the agent; nothing listens
to `extra.signal`). The revised proposal is a concrete design (running-state lock,
adapters kill on abort + reject, `cancelled` terminal state, MCP-path-first scope).

## Verdict / next

Stepwise MCP with a live heartbeat is the conversational surface. Deferred no
longer: this is the direction. Surfaced work items, in order:
1. `running`-state start lock (small, real bug, independent).
2. Cooperative cancellation (thread `extra.signal` → adapters kill the child).
3. Then consider within-step adapter event streaming (richer than the timer
   heartbeat).
