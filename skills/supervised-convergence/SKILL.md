---
name: supervised-convergence
description: Bounded implement -> check -> decide loop. You (this chat) implement a slice with full tools, the chit Codex advisor reviews it, and you repeat until the work converges or needs the human. Use when the user wants iterative implementation with a skeptical second-opinion review each round, stopping when done or blocked.
---

# Supervised convergence loop

To install: copy this directory to `~/.claude/skills/supervised-convergence/`
(user-global) or a project's `.claude/skills/`. Then edit the `manifest_path`
bullet under step 2 ("Check") below and replace the `<MANIFEST_PATH>`
placeholder with the absolute path to your `codex-advisor-thread.json` (this
repo ships one at `apps/cli/examples/codex-advisor-thread.json`). Requires the
chit MCP server registered (`docs/mcp-v0.md`).

Roles, fixed:
- **You (this chat) are the executor and loop owner.** You have the real tools
  (read, edit, run tests, ask the user). You do the implementing.
- **chit's Codex advisor is the checker** (read-only, persistent per scope). It
  only advises; it never edits.
- **The human is the supervisor and final authority.** The loop stops and hands
  back to them at the checkpoints below.

This loop does NOT live in chit (chit can't loop or pause). You run it. chit
runs one bounded check per call.

## The loop (default max 3 iterations unless the user sets another budget)

Each iteration:

1. **Implement** one small, verifiable slice of the task with your own tools.
2. **Check** by calling the chit Codex advisor over MCP:
   - `chit_start` with:
     - `manifest_path`: `<MANIFEST_PATH>` (replace this placeholder at install time with your absolute path to codex-advisor-thread.json)
     - `scope`: a stable name for THIS task/thread. Reuse the SAME scope every
       iteration so Codex keeps the thread's context. Derive it from the
       ticket/topic; ask the user once if unclear. (A scope is required.)
     - `cwd`: the repo you're working in (so Codex inspects the right files).
     - `inputs.task`: the task or decision under review.
     - `inputs.claude_response`: exactly what you just changed or plan to do (a
       tight diff summary + your reasoning).
     - `inputs.context` (optional): anything Codex needs that isn't in the repo.
   - then `chit_run_step` on the `review` step, and read its
     `proceed | revise | block` verdict.
3. **Decide** from the verdict:
   - **proceed**: the slice holds. If the task is complete, STOP and summarize.
     Otherwise go to the next slice.
   - **revise**: address Codex's concrete findings, then re-check (the next
     iteration). Do NOT treat Codex as automatically right - verify each finding
     against the code yourself before acting; if a finding is wrong, say why and
     proceed anyway.
   - **block**: STOP and surface the blocker to the human.

## Stop conditions (end the loop, hand back to the human)

- Codex returns `block`.
- An ambiguous product or design decision only the human can make.
- Failing tests whose fix requires a user choice.
- Any destructive or outward-facing action (deleting data, `git push`, deploys) -
  never do these autonomously; ask.
- Max iterations reached - stop and summarize what's done and the unresolved risk.

## Rules

- You implement; Codex only advises. Never let it edit, and never treat its
  review as ground truth - verify before acting (MUST).
- Reuse the same `scope` across iterations; pass `cwd` = the repo; do NOT change
  the advisor config or its role mid-thread (it forks a fresh Codex thread and
  loses context).
- Keep each slice small enough that one review is meaningful.
- Always end by telling the human, plainly: what changed, the last verdict, and
  why you stopped (converged / blocked / needs a decision / hit max iterations).

## Out of scope (do not do these)

- Do not put the loop, conditionals, or a checkpoint step into a chit manifest -
  chit is a static DAG by design.
- Do not spawn a headless Claude inside chit to implement - `claude --print` is a
  weak one-shot reasoner, not this chat. You are the executor.
- Do not import external Codex/Claude sessions; start fresh per scope.
