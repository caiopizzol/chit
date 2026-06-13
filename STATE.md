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

## Increment 2 COMPLETE — step-based converge (configurable, no fixed roles)
- [x] Loop is now STEP-BASED, not implementer/reviewer slots. A manifest is ordered steps
      (`call` / `format` / `check`); "build"/"critique" are step ids, "builder"/"critic" are
      participant names. Roles are examples, not runtime concepts. (other-model catch on my
      earlier fixed-slot CONVERGE-DESIGN was correct; design changed.)
- [x] check step kind; converge requires >=1 check step (its convergence signal).
- [x] `{{ iteration }}` template var; cross-iteration step refs via a pre-seeded loop context.
- [x] CheckRunner seam: fakeCheckRunner (tests) + argvCheckRunner (real).
- [x] runConverge executor: loops steps until all checks pass or maxIterations; feeds failing
      check output forward to the next iteration's call steps. Fake-backed, deterministic.
- [x] ConvergeReceipt / IterationReceipt (tagged union by policy); store + trace handle both.
- [x] example implementation-review.json rewritten step-based; inspect renders it.
- [x] 77 tests pass, typecheck clean. Proven: fail -> feedback -> converge (converge.test.ts).

## Increment 3 COMPLETE — write-safe live converge (the real end-to-end loop)
- [x] Sandbox seam (sandbox.ts): fakeSandbox + gitWorktreeSandboxFactory (real git worktree,
      node_modules symlinked, diff/apply/discard). Tested against a throwaway git repo.
- [x] runConvergeInSandbox (converge-run.ts): create sandbox -> run loop with cwd=sandbox ->
      show diff -> apply ONLY if converged AND --apply, else discard. Always tears down. Tested with fakes.
- [x] adapter is permission-aware (acceptEdits / plan / none) and runs in the sandbox cwd.
- [x] {{ diff }} template var + diffProvider thread the live sandbox diff to review steps.
- [x] CLI: `chit run <converge>` runs live; DRY-RUN by default (discard), `--apply` writes back.
- [x] trace shows iterations, per-check results, and the diffstat.
- [x] REAL end-to-end smoke PASSED: `chit run sandbox-smoke` -> real claude created smoke.txt in a
      git-worktree sandbox -> real `grep` check passed -> converged 1 iter -> diff shown -> dry-run
      discarded -> origin untouched, no leftover worktree, receipt run-12c4ae18 traces correctly.
- [x] 87 tests pass, typecheck clean.

## Increment 4 COMPLETE — safety bounds + doc fixes
- [x] proc.ts spawnCapture(timeoutMs): kills a hung process; tested (sleep + short timeout).
- [x] adapter + argv check-runner route through it: per-call timeout (5 min). A hung model call
      or hung check can no longer block a run.
- [x] converge maxWallMs guard (CLI default 30 min): aborts before exhausting iterations; tested.
- [x] README fixes: removed stale "converge execution" from not-here; clarified per-participant
      claude-permission enforcement (plan/acceptEdits/none) vs the stronger worktree write-safety;
      noted the timeouts. 92 tests, typecheck clean.

## STRESS TEST PASSED — real source-editing converge
- [x] implementation-review (diff-aware critic via {{ diff }}) vs a real task: builder created
      src/greet.ts + src/greet.test.ts, critic reviewed the diff, real `bun run typecheck` AND
      `bun test` passed in the sandbox, converged in 1 iteration (~2 min), origin untouched,
      no leftover worktree. Receipt run-3562f9d0.
- CAVEAT: it converged first-try, so a REAL multi-iteration fail->feedback->revise was not
  exercised here (that path is proven only by the fake-backed converge tests). Critic took ~90s;
  diff size will grow critic cost -- the {{ diff }} budget cap is still worth doing.

## Next (loop is now stressed + safe)
- [ ] {{ diff }} prompt-budget: cap/elide large diffs fed to review prompts.
- [ ] routine composition (grill -> plan -> implementation-review)  <-- now unblocked.
- deferred still: durable resume, live progress/pause, cost budgets, richer receipts, parallel fan-out.

## Not in scope (deferred on purpose)
Studio, MCP, plan/batch, converge execution, config editor, multi-provider adapters,
filesystem-permission enforcement (shown + passed to adapter, not enforced yet).
