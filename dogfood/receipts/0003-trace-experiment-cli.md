# 0003 trace experiment (CLI)

- date: 2026-05-29
- what: added opt-in `--trace` (CLI) / `chit install --trace` (skill) and ran it
  against two chits to test whether a step transcript dissolves the "black box"
  feeling reported when invoking a skill.
- agents: claude `/Applications/cmux.app/.../claude` 2.1.156, codex 0.134.0
- result: pass (CLI level); the in-chat skill re-run is the user's to judge.

## Why

Invoking a skill shows a spinner then one final block: you cannot see what chit
sent to each agent, in what order, or how long each took. Two structural walls:
the skill `!` block substitutes output only after the command completes (no
streaming), and chit emitted no step trace at all (only the final output). So
even post-hoc there was nothing to inspect.

## What changed

`--trace` renders, per step: participant, agent, session policy, elapsed,
status, and prompt/output previews (full payloads stay in `result.trace`; the
renderer previews, capped at 280 chars). Opt-in; default output unchanged.
`chit install --trace` bakes it into the generated skill.

## consult-stateless --trace

The transcript makes the parallel fan-out visible: both calls start before
either finishes.

```
chit: trace > step "ask_claude": call claude (agent claude, session stateless)
chit: trace |   prompt: Name one benefit of a monorepo, in 5 words.
chit: trace > step "ask_codex": call codex (agent codex, session stateless)
chit: trace |   prompt: Name one benefit of a monorepo, in 5 words.
chit: trace < step "ask_claude": done in 4740ms
chit: trace |   output: ... Atomic cross-package changes in one commit.
chit: trace < step "ask_codex": done in 9506ms
chit: trace |   output: Atomic cross-package changes are easier.
chit: trace > step "out": format
chit: trace < step "out": done in 0ms
```

## propose-verify-revise --trace

Sequential handoff with timings: propose (claude, per_scope) 5072ms -> verify
(codex) 31160ms -> revise (claude, per_scope) 12840ms -> format 0ms. The revise
output began "Changes from the first version: Dropped --global ... Corrected the
description ..." while the revise prompt contained ONLY Codex's review, never
the original proposal. So per_scope session resume carried Claude's own prior
turn within a single run, and the trace makes that legible.

## What it does and does not solve

- Solves: "I do not know what chit sent and received." You now see the prompts,
  the order, the per-step timing, and output previews. Live in a terminal;
  buffered-then-shown via the skill.
- Does NOT solve: "watch the agent think" (the adapter keeps only the final
  answer; codex's/claude's intermediate reasoning is discarded), or "jump in
  mid-flow" (the run is still one closed call).

## Headless multi-task run (sub-agent, 2026-05-29)

Ran three more tasks headless (via `chit run --trace`, not the in-chat skill) to
learn how trace + the handoff behave across task types. All exited 0 first try.

- TASK A (`ask-codex`, single call): codex read the named file and cited real
  lines (`codex-exec.ts:46-58`, `:97-120`). Trace adds little for one call, as
  expected. `ask` step: 46s.
- TASK B (`propose-verify-revise`, README task): propose 27s, **verify 164s**,
  revise 35s. Codex gave five file:line-cited findings (caught the
  `bun run cli --cwd apps/cli` path mismatch); claude's revise addressed all
  five and changed the artifact.
- TASK C (`propose-verify-revise`, the permission-gate decision): propose 15s,
  **verify 141s**, revise 48s. Codex caught a substantive error: claude first
  recommended "Option 2 now," and codex flagged that this contradicts the
  source proposal's own "defer until Dogfood v0 finishes" and that "remove the
  read_only default from examples" is mechanically wrong (examples omit
  `permissions`; the parser supplies `read_only` at parse.ts:148). Claude's
  revise retracted "Option 2 now" and "zero weakening" - phrases from its own
  proposal that were NOT in the revise prompt, so per_scope resume is reproven.

What this teaches (headless can show this): the handoff is real, not theater
(codex produced specific, cited critique and in C flipped the answer), output
quality is high, and per_scope resume works. What it sharpened: the dominant
discomfort is not (only) between-step steering - it is the **silent multi-minute
verify step** (141-164s here vs 31s in the first run; it varies). The trace
shows `> step "verify"` then nothing until it finishes, because the adapter
discards intermediate agent events (TASK A's finding). A human watching that
gap would reasonably think it hung. Step-level trace does not fix this; neither
would step-level MCP tool calls by themselves. The deeper lever is surfacing
*within-step* progress (the intermediate events the adapter currently throws
away).

## Follow-ups

- The in-chat re-run is the gate (both skills reinstalled with `--trace`): does
  the transcript make the batch skill feel acceptable? See
  proposals/conversational-handoff-needs-mcp.md. If not, the next bet is
  stepwise static DAG over MCP.
- Cleanup when done: `chit uninstall ask-codex` and
  `chit uninstall propose-verify-revise`.
