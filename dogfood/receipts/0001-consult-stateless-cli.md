# 0001 consult-stateless (CLI)

- date: 2026-05-28
- command: `bun apps/cli/src/cli/run.ts run apps/cli/examples/consult-stateless.json --allow-unenforced-permissions --input question="In one sentence, what is a monorepo?"`
- manifest: `apps/cli/examples/consult-stateless.json`
- surface: CLI
- agents: claude `/Applications/cmux.app/.../claude` 2.1.156, codex 0.134.0 (run-shell binaries)
- result: pass
- exit code: 0 (with flag) / 2 (without flag, see below)
- time: 8.68s wall (`8.30s user 4.52s system 147% cpu`)
- token / cost: not surfaced by the CLI

## What happened

First attempt, no flag, exited 2 before reaching any agent:

```
chit: cannot enforce required permissions for "consult-stateless":
  - participant "claude" (agent "claude") requires filesystem: read_only, but its adapter cannot enforce it

Pass --allow-unenforced-permissions to run anyway (emits a warning each run).
```

Second attempt, with `--allow-unenforced-permissions`, exited 0. Both agents
ran (147% CPU confirms the two calls overlapped, i.e. real parallel fan-out),
and the `format` step merged both answers under their headings:

```
## codex
A monorepo is a single version-controlled repository that contains multiple projects, packages, services, or apps that are developed and managed together.

## claude
A monorepo is a single version-control repository that holds the code for many distinct projects, packages, or services, instead of splitting each into its own separate repository.
```

A single warning on stderr (not an error):

```
chit: WARNING -- unenforced permissions:
  - participant "claude" (agent "claude") declares filesystem: read_only; adapter cannot enforce it
```

## Friction

- **Reduced copy-paste?** Yes. One command fanned the same question to two
  different agent CLIs in parallel and returned a single merged answer. Doing
  this by hand is two terminals plus manual stitching.
- **Manifest shape too narrow?** No, for this task the static fan-out/fan-in
  graph is exactly right.
- **Surprise:** the permission gate fires on `chit run`, not just on install.
  A new user's very first run of any claude-containing chit fails with exit 2
  until they discover `--allow-unenforced-permissions`. The error text does
  name the flag, which softens it, but it is still a stop-on-first-try.
- **Reproducibility hazard:** the run shell's `claude` (cmux, 2.1.156) is not
  the same binary as an interactive shell's (2.1.98). Pinned the run-shell
  binary above.

## Follow-ups

- Consider whether `read_only` should be the default for claude participants
  given claude-cli cannot enforce it, or whether the first-run error should be
  a warning-and-proceed for `read_only` specifically. Worth a proposal, not a
  fix yet (dogfood should decide).
- Next: scenario 4, `consult` with `--scope`, to test `per_scope` resume.
