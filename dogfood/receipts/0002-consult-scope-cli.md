# 0002 consult per_scope resume (CLI)

- date: 2026-05-28
- command (run 1): `bun apps/cli/src/cli/run.ts run apps/cli/examples/consult.json --scope dogfood-1 --allow-unenforced-permissions --input question="Remember this token for later: BANANA-42. Reply with only the word noted."`
- command (run 2): same, with `--input question="What token did I ask you to remember a moment ago? Reply with only the token."`
- manifest: `apps/cli/examples/consult.json` (both participants `session: per_scope`)
- surface: CLI
- agents: claude `/Applications/cmux.app/.../claude` 2.1.156, codex 0.134.0
- result: pass
- exit code: 0 and 0
- time: run1 + run2 ~13s total wall (20:46:31 -> 20:46:44)
- token / cost: not surfaced

## What happened

Two runs sharing `--scope dogfood-1`. Run 2 asked for a token that was only
mentioned in run 1, so a correct answer can only come from a resumed session.

Run 1 output:

```
## codex
noted

## claude
BANANA-42
```

Run 2 output (the resume test):

```
## codex
BANANA-42

## claude
BANANA-42
```

Both agents recalled `BANANA-42` in run 2. `per_scope` session state persists
across separate `chit run` invocations keyed by `--scope`. Session resume works.

## Friction

- **Reduced copy-paste?** Yes, and this is closer to the product truth test:
  two agents, one routine, with memory across invocations, no manual session
  juggling.
- **Manifest shape too narrow?** No.
- **Agent-behavior nit (not a chit bug):** in run 1, claude ignored "reply with
  only the word noted" and echoed `BANANA-42` instead. Codex followed the
  instruction. The runtime did its job (resumed correctly); this is just model
  behavior. Worth knowing when writing prompts in chits: instructions are
  advisory to the agent, not enforced by chit.

## Follow-ups

- Same permission-warning friction as 0001 (claude `read_only`); see that
  receipt's follow-up.
- Next: the real milestone test. Studio edit -> install -> invoke the installed
  skill inside a Claude Code session (scenarios 5-8). These are manual and the
  user drives them; the receipts go here as 0003+.
