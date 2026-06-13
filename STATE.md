# chit-minimal — build state

## Objective
Prove the Chit product model with one public concept: **a routine is a declared workflow**.
Chit can **list** it, **inspect** it, **run** it, and **trace** what happened. CLI only.

Built from scratch (no `@chit-run/*` dependency). Reuses the *concepts*, not the code.

## Decisions
- **Standalone sibling package** at `/Users/cpolive/dev/personal/chit-minimal`, so it never entangles
  with the hardened monorepo's workspaces/CI.
- **Manifest is the source of truth** for inputs, participants, steps, policy, prompts, checks.
  **Config only names routines** and points at a manifest. Inputs are never duplicated into config.
- **one-shot vs converge are execution policies**, not separate user-facing product families.
- **Execution boundary**: one-shot runs for real via a thin adapter that shells out to the `claude`
  CLI (already installed; no new secrets, no HTTP). Converge is inspectable; its *execution* is
  deferred (the hardened loop/digest/drift machinery is NOT reimplemented here).
- Adapter is an injectable interface so the run flow is testable with a fake (no real model calls in tests).

## Public surface
- `chit routines` — list declared routines (id, policy, description)
- `chit inspect <routine>` — description, policy, required inputs, participants+agents, filesystem,
  steps (or loop+checks), manifest path + digest
- `chit run <routine> [--input k=v ...] [--scope s]` — resolve, validate inputs, execute, print run id + output
- `chit trace <run-id>` — receipt: what/who ran, status, elapsed, checks/verdict; no transcript bodies by default

## Status — increment 1 COMPLETE
- [x] scaffold (package.json, tsconfig, .gitignore)
- [x] manifest model + parser (+tests)
- [x] config model + loader (+tests)
- [x] input validation (+tests)
- [x] template render (+tests)
- [x] adapter interface + fake + claude-cli
- [x] routine resolve (+digest)
- [x] run (one-shot) (+tests w/ fake adapter)
- [x] trace (+tests)
- [x] cli dispatch (+tests) + bin entry
- [x] examples (feature-griller, planning, implementation-review) + chit.config.json + README
- [x] verify: 62 tests green, typecheck clean, real `routines`/`inspect`/`trace` smoke
- [x] REAL end-to-end: `chit run feature-griller` shelled to claude, grilled chit-minimal
      (manifest REQUESTED read-only; not enforced, but verified no stray writes this run),
      printed a grounded report, persisted receipt run-a109eae0, trace renders it.
      NOTE: receipts store inputs + final output in plaintext (.chit/runs, gitignored).

## Next candidates (not started)
- converge executor proven with a FAKE adapter + FAKE check-runner first (mirror how one-shot
  was proven), iteration-shaped receipt, explicit convergence contract. Decide prompt source
  (manifest vs executor) and the done-signal BEFORE code. Real check-runner + fs safety later.
- `--full` flag on trace to print the stored output body.
- biome/lint config if this graduates past a proof.

## Not in scope (deferred on purpose)
Studio, MCP, plan/batch, converge execution, config editor, multi-provider adapters,
filesystem-permission enforcement (shown + passed to adapter, not enforced yet).
