# 0005 chit_cancel verified against real codex

- date: 2026-05-29
- surface: chit MCP server (`apps/cli/src/surfaces/mcp/`), commit 49ee7e1
- how: drove the server over stdio and sent `chit_cancel` as a separate
  concurrent request while a real-codex `chit_run_step` was in flight (the
  protocol shape a follow-up turn would use). No Esc, no Claude Code UI.

## What happened

```
chit_run_step (real codex) ...
  [heartbeat] ask · starting · call codex (codex)
  [heartbeat] ask · codex (codex) still running · 5s elapsed
chit_cancel after ~6s ...
chit_cancel -> { "step": "ask", "cancelled": true, ..., "ready": [] }
  [heartbeat] ask · cancelled after 6013ms
chit_run_step returned after 6s -> { "cancelled": true, "durationMs": 6013, ... }
```

- A separate `chit_cancel` request reached the in-flight step, aborted its
  controller, and killed the real codex child: `chit_run_step` returned at ~6s,
  not the ~220s codex would have taken — proof the child was killed, not awaited.
- `chit_cancel` returned `cancelled: true`; the step settled `cancelled`;
  `ready: []` confirms dependents stay blocked.

## What this proves / does not

- Proves: the explicit `chit_cancel` mechanism works end to end against a real
  agent — controller abort → child kill → cancelled terminal state → dependents
  blocked. This is the part unit tests (fake adapters) could not fully cover.
- Does NOT prove: the Claude Code UI gesture — that pressing Esc interrupts a
  blocked `chit_run_step` turn so the user can issue `chit_cancel` in a follow-up
  turn. Esc was never pressed across five live runs, so that ergonomics question
  is unobserved. It is a client behavior, not a correctness gap. If Esc turns out
  not to interrupt a blocked MCP-tool turn, in-session triggering would need the
  pure-async model (chit_run_step returns immediately) — a future refinement.

## Backlog (real bugs the dogfood reviews surfaced, not yet fixed)

- step-id keys written into plain `{}` (records/outputs) allow `__proto__`-style
  pollution; use `Object.create(null)` or reject reserved keys.
- `runStep` doesn't check `signal.aborted` before starting or before committing
  `done` (a cancel landing in those windows is missed).
- `isComplete` checks only the output step; independent non-output branches can
  be left pending while the run reports complete.
- `per_scope` silently runs stateless when `scope` is omitted; should reject or
  derive a scope.
