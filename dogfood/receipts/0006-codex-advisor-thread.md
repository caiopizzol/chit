# 0006 codex-advisor-thread: persistent advisor memory verified

- date: 2026-05-29
- config: `apps/cli/examples/codex-advisor-thread.json` (single codex participant,
  `per_scope`, three inputs: task / claude_response / context). MCP-driven.
- agents: codex 0.134.0 (read_only, enforced).
- goal: confirm Codex carries context across separate questions on one scope,
  so it reviews with accumulated history instead of as a fresh one-off.

## Run (one scope: `val-codex-thread`)

1. task "review my API rate limiter", claude_response "fixed-window counter,
   100/60s". Codex (137s) returned `revise` with repo-cited findings, including
   the fixed-window boundary-burst (~200/min).
2. SAME scope. task "I changed it based on your main concern — does it hold?",
   claude_response "switched to a token bucket, capacity 100, refill 100/min".
   I did NOT restate what the concern was, nor mention "fixed-window".

Run 2's review (89s) opened: *"Token bucket is a better algorithm than
**fixed-window**…"* and tracked findings as *"still unresolved / still
underspecified / still missing"* — reviewing the new approach against its own
Run 1 critique, none of which I restated. **Per_scope memory across separate
runs is proven for the advisor thread.**

## Also confirmed

- Codex actually inspects the repo under the read-only sandbox: both runs cited
  `apps/web`/`apps/studio` `file:line`, ran `rg`, ran `typecheck`, and Run 2 ran
  `bun test apps/studio/src/server/server.test.ts` → `43 pass`. So it reads and
  runs non-mutating checks, not just reasons from the pasted text. (`cwd` was the
  repo — required for this; it's in the usage notes.)
- No permission gap: codex enforces `read_only`, so no unenforced-permission
  warning and no `allow_unenforced_permissions` needed.

## Notes / contract reminders (in the manifest description too)

- Same scope = same thread; new scope for unrelated work.
- Pass `cwd` = the repo so Codex inspects the right files.
- Do not edit the advisor `role` mid-thread — role is in the session
  fingerprint, so editing it starts a fresh Codex thread.
- MCP-only (three inputs; not claude-skill-installable). Preserves Codex
  context, not Claude chat context (Claude's context is your Claude Code chat).
- The superseded two-Claude `advise-and-execute` sketch was dropped: it spawned
  a second Claude that isn't your chat, and removed the human "let's go"
  checkpoint. A headless full-loop recipe can be built later if a real need
  appears.
