# Supervised convergence (pattern)

The use case: "run an implement -> check loop until it converges or needs me."
This is NOT a chit runtime feature. It is an orchestrator pattern *on top of*
chit's primitives, and it's the recommended shape today (validated against the
code; see receipts 0004-0006 and `notes/proposals/conversational-handoff-needs-mcp.md`).

## Why it lives above chit, not inside it

- chit manifests are static DAGs: no loops, no conditionals, no human-checkpoint
  step (`parse.ts` topological sort rejects cycles; step kinds are only `call` /
  `format`; `notes/backlog.md` defers HITL). A "repeat until" cannot be expressed
  in a manifest, by design.
- chit's implementer is real (this was previously mischaracterized here):
  `claude-cli` runs `claude --print`, which uses tools and edits files - verified,
  and the `converge` manifest (`examples/converge.json`) drives it
  autonomously (a write-capable Claude implements; `codex-exec --sandbox
  read-only` reviews). So the executor can be either the interactive Claude Code
  chat (full conversational context, your per-edit approval) or a chit-spawned
  Claude (autonomous, run under a worktree + human checkpoint).

So the loop and the checkpoint belong to the orchestrator (the chat); chit runs
one bounded check per call.

## The role split

| Concern | Owner |
|---|---|
| implement | the Claude Code chat (full tools + your oversight) |
| check | chit's persistent `per_scope` Codex advisor (`codex-advisor-thread`, read-only enforced) |
| loop control + iteration budget | the chat (re-drives chit each round) |
| human checkpoint | the chat (a terminal stop state, not a manifest step) |

One chit run = one turn of the loop. The `while` lives in the chat.

## The loop

Per iteration (default budget: 3):
1. Chat implements one small, verifiable slice.
2. Chat calls the advisor: `chit_start` (`codex-advisor-thread.json`, a stable
   `scope` per thread, `cwd` = the repo, `inputs.task` + `inputs.claude_response`
   = what changed) then `chit_run_step review`.
3. Chat decides on the `proceed | revise | block` verdict: proceed -> next slice
   (or stop if done); revise -> fix and re-check (verify each finding first;
   Codex is not ground truth); block -> stop and surface to the human.

Stop conditions: `block`; an ambiguous product/design decision; failing tests
needing a user choice; any destructive/outward-facing action; or max iterations.

The shipped form is the Claude Code skill versioned in this repo at
`skills/supervised-convergence/SKILL.md`, which encodes this policy. Install it
by copying that directory to `~/.claude/skills/` (user-global) or a project's
`.claude/skills/`, and set the skill's `manifest_path` to your absolute path to
`examples/codex-advisor-thread.json`. It needs zero chit code changes
and runs against the shipped MCP server.

## What this is NOT (and why)

- Autonomous "Chit Converge" now EXISTS - the spike passed. The `converge`
  manifest (`examples/converge.json`) runs a write-capable `claude-cli`
  implementer plus a read-only `codex-exec` reviewer, driven from the MCP one
  iteration per `chit_start` while a human sequences and checkpoints (run under a
  worktree). Supervised convergence (this doc) is the lighter-weight mode when you
  want this conversation's context to do the implementing; reach for the converge
  manifest when you want the agents to run it themselves. The real constraint is
  unchanged: manifests can't loop, so the iteration is always driven by an
  orchestrator, never the manifest.
- Not a manifest loop / conditional / checkpoint step kind (breaks the static-DAG
  thesis; the chat loops and checkpoints for free).
- Not a second headless Claude inside chit (weak, context-blind, drifts from the
  chat).

## Reminders that bite

- Prefer `codex-exec` as the checker: it runs in a hard OS sandbox
  (`--sandbox read-only`), the firmest read-only guarantee. `claude-cli` now also
  enforces `read_only` via `--permission-mode plan` (a softer, permission-level
  guarantee inside Claude, not an OS sandbox), so it can serve as a read-only
  reviewer too; codex stays the default for the strongest boundary.
- Reuse one `scope` per thread; pass `cwd` = the repo; don't edit the advisor
  `role` mid-thread (it's in the session fingerprint and forks a fresh thread).
- Keep the advisor serial per scope (the session store has a read-modify-write
  race on concurrent same-scope writes).

## Platform note (others building on top)

The substrate to build on is the MCP stepwise tool set (`chit_start` /
`chit_next` / `chit_run_step` / `chit_cancel` / `chit_trace`, `notes/mcp-v0.md`)
with one invariant: **chit governs the declared legal order and runs one bounded
handoff to a result; the orchestrator owns the loop and the checkpoint.** Build
loop policies (like this one) above that line, not inside the manifest.
