# Supervised convergence (pattern)

The use case: "run an implement -> check loop until it converges or needs me."
This is NOT a chit runtime feature. It is an orchestrator pattern *on top of*
chit's primitives, and it's the recommended shape today (validated against the
code; see receipts 0004-0006 and `proposals/conversational-handoff-needs-mcp.md`).

## Why it lives above chit, not inside it

- chit manifests are static DAGs: no loops, no conditionals, no human-checkpoint
  step (`parse.ts` topological sort rejects cycles; step kinds are only `call` /
  `format`; `docs/backlog.md` defers HITL). A "repeat until" cannot be expressed
  in a manifest, by design.
- chit has no strong implementer: `claude-cli` runs `claude --print` (one-shot,
  keeps only the final result, no iterative edits) and `codex-exec` is
  `--sandbox read-only`. The strongest, most-supervised executor available is the
  interactive Claude Code chat (full tools, edits, tests, your approval).

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

The shipped form is the user-global Claude Code skill `supervised-convergence`
(`~/.claude/skills/supervised-convergence/SKILL.md`), which encodes this policy.
It needs zero chit code changes and runs against the shipped MCP server.

## What this is NOT (and why)

- Not an autonomous "Chit Converge" that implements on its own. That needs a
  write-capable, tool-using executor adapter, which does not exist and is the
  hard/risky part (sandbox + permissions + unsupervised edits). It is gated
  behind a focused spike: *can a chit-spawned write-capable agent make a small
  repo change that a read-only reviewer then catches/accepts?* Build the
  autonomous loop only if that passes; until then, the chat is the executor.
- Not a manifest loop / conditional / checkpoint step kind (breaks the static-DAG
  thesis; the chat loops and checkpoints for free).
- Not a second headless Claude inside chit (weak, context-blind, drifts from the
  chat).

## Reminders that bite

- The checker must be `codex-exec` (it actually enforces `read-only`).
  `claude-cli` is not yet sandboxed (`docs/backlog.md`), so don't rely on it as a
  read-only reviewer.
- Reuse one `scope` per thread; pass `cwd` = the repo; don't edit the advisor
  `role` mid-thread (it's in the session fingerprint and forks a fresh thread).
- Keep the advisor serial per scope (the session store has a read-modify-write
  race on concurrent same-scope writes).

## Platform note (others building on top)

The substrate to build on is the MCP stepwise tool set (`chit_start` /
`chit_next` / `chit_run_step` / `chit_cancel` / `chit_trace`, `docs/mcp-v0.md`)
with one invariant: **chit governs the declared legal order and runs one bounded
handoff to a result; the orchestrator owns the loop and the checkpoint.** Build
loop policies (like this one) above that line, not inside the manifest.
