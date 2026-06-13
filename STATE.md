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
- **v2: NO `policy` field.** Behavior is DERIVED from shape (routine steps -> composition; `repeat`
  -> loop; read-write participant or any check step -> sandboxed). The user writes one shape.
- **Execution boundary**: one-shot AND converge both run for real via a thin `claude` CLI adapter
  (no secrets, no HTTP). Converge edits inside a disposable git worktree (dry-run by default,
  `--apply` to write back); the hardened digest/drift machinery is NOT reimplemented here.
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

## Increment 5 COMPLETE — honest + bounded single loop
- [x] fixed stale wording: inspect note (was "gated", now describes live sandbox + dry-run),
      README test count (62 -> 92), STATE "Not in scope" (dropped converge execution; corrected
      the filesystem-permission wording).
- [x] {{ diff }} prompt-budget cap (capDiffForPrompt, 20k chars + truncation note); tested.
- [x] REAL multi-iteration recovery field-tested: `forced-revise` -> builder cannot guess the
      required content, check fails iteration 1, learns it from the failing check, fixes it,
      converges iteration 2. Receipt run-e151ed72 (iter1 check fail, iter2 check ok). Origin clean.
      Closes the "revise-after-failed-checks not field-tested" gap.
- [x] 94 tests, typecheck clean.

## Increment 6 COMPLETE — routine composition (flows), Option-1 contract
- [x] `policy: "flow"`: steps invoke OTHER routines, mapping inputs/outputs via the existing
      templating. Structural parse only; graph checks are config-aware (resolveFlow). flow.ts.
- [x] Option-1 contract enforced at resolve: sub-routines are one-shot|converge (no nested flows
      -> no cycles); at most one converge step and it MUST be last; one-shot steps must be
      READ-ONLY (they run in the caller cwd unsandboxed -- the terminal converge is the only writer).
- [x] runFlow: runs each sub-routine in order, passes outputs forward, chains receipts. The terminal
      converge inherits dry-run-by-default + --apply. Fake-backed, tested (output passing, terminal
      diff/apply, failure propagation, invalid mapped inputs).
- [x] FlowReceipt is body-free (step/sub-run ids, statuses); one-shot SUB-receipts still hold their
      output bodies (documented -- the honest version of "body-free").
- [x] store/views/cli handle the third receipt shape; inspect shows the routine chain; trace shows it.
- [x] example feature-flow = grill -> plan -> implementation-review. 105 tests, typecheck clean.
- [x] REAL end-to-end smoke PASSED: `chit run feature-flow --input idea=...` ran grill -> plan ->
      impl for real; output passed forward each step; the terminal converge built double.ts + a
      passing test in its sandbox (real typecheck+test), converged, dry-run discarded. Origin clean,
      no leftover worktree. Flow receipt run-9cf66a34 chains sub-runs (run-1b2ec16d, run-dbcc94aa,
      run-f5111fa3); `chit trace <subRunId>` works per step. NOTE: ~12.5 min wall-clock (3 real
      model calls + a converge loop) -- reinforces that live progress + budgets are the real next needs.

## Increment 6.1 — flow propagation fixes (review follow-ups)
- [x] flow now forwards a converge sub-routine's config `defaults.maxIterations` into the sub-run,
      so it behaves identically inside a flow and standalone (was ignored before).
- [x] flow `scope` propagates to every sub-run (one-shot + converge), so the whole chain shares it.
- [x] resolveFlow now also validates `{{ inputs.X }}` refs against the declared flow inputs (a typo
      is caught at resolve, not silently rendered empty). 108 tests, typecheck clean.

## Increment 7 COMPLETE — v2 manifest (one shape, derived behavior) [BREAKING]
- [x] removed `policy`. Manifest = inputs + participants + steps + optional repeat + output.
      Step kinds: call / format / check / routine. CONTRACT-V2.md is the spec.
- [x] derived: routine steps -> composition; `repeat` -> loop; read-write participant OR any
      check step -> sandboxed (worktree); pure read-only call/format -> cwd. (D broadened: checks
      are arbitrary process execution, so they get the boundary too.)
- [x] rules at resolve: no step mixing; repeat needs a check + non-composition; output names a
      text step (not check); composition calls execution routines only (no nesting), at most one
      sandboxed sub-routine and it must be last.
- [x] executors reused via dispatch (text -> runOneShot/cwd; sandboxed -> runConverge/worktree,
      maxIter from repeat or 1; composition -> runFlow). All examples + tests converted.
- [x] 108 tests, typecheck clean. CLI smoke: routines shows text/loop/composition; inspect/run derive.

## Increment 8 — v2 DX pass + acceptance closed
- [x] DX wording: README rewritten around one shape + derived behavior; CLI help/labels no longer
      say policy/one-shot/converge ("converge:" run label -> "run <status>"); receipt `policy`
      documented as an internal per-kind tag. Dropped the unverifiable "Biome clean" claim
      (Biome is not configured here; gates are `bun test` + `tsc`).
- [x] FOUND+FIXED via the acceptance run: the 5-min per-call timeout killed a legit ~5-min planning
      call (feature-flow failed at plan). Raised to 10 min (46cadb8).
- [x] ACCEPTANCE CLOSED on v2: real `feature-flow` (grill->plan->impl) converged end-to-end
      (run-daa20f5a): grill completed, output fed to plan (293s, completed), impl converged in a
      sandbox; dry-run discarded; origin clean; no leftover worktree.
- known edge: force-killing a sandboxed run mid-flight skips its worktree cleanup (leak); add a guard.

## Increment 9 — operator control, step 1: live progress + cleanup
- [x] live progress: executors emit step/iteration/check/sub-routine events through an optional
      onProgress sink; the bin streams them to stderr as they happen (result stays on stdout).
      Verified on a real run (creating sandbox -> iteration 1 -> call builder -> check ... -> ok).
- [x] `chit cleanup`: reapStaleSandboxes removes sandbox worktrees left by an interrupted run
      (force-kill skips finally-discard). Tested (real git) + CLI. 112 tests, typecheck clean.

## Increment 10 COMPLETE — configurable limits + cleanup hardening
- [x] per-routine `limits` { callTimeoutMinutes, runTimeoutMinutes }, each a positive number of
      minutes or "none" to opt out. High defaults (30m call / 120m run); maxIterations always kept.
      Replaced the hidden 10m per-call constant: the per-call bound flows manifest -> adapter
      (effectiveCallTimeoutMs); the whole-run bound drives the converge wall-time
      (effectiveRunTimeoutMs; CLI no longer hardcodes 30m). (+ manifest/run/adapter tests.)
- [x] inspect SURFACES the effective bounds ("limits: per call 30m, whole run 120m") so a bound is
      never invisible -- the whole-run line shows only on the sandboxed/loop path (a text run has no
      whole-run bound). planning + implementation-review examples carry a `limits` block as the
      in-repo demo. CONTRACT-V2 + README document it.
- [x] HARDENED `chit cleanup`: a sandbox writes an owner.pid liveness lock; reap SKIPS any sandbox
      whose owner is still alive (process.kill(pid,0)), so a cleanup mid-run cannot pull a live
      worktree out from under it. Also fixed a latent leak: discard + reap now remove the tmp PARENT
      dir (old code left empty chit-sbx-* husks forever; clean-room verified 0 husks after a full
      suite run). Tests: dead-owner reaped, live-owner skipped (real git + real pid), CLI removal path.
- [x] 124 tests, typecheck clean.

## Increment 10.1 — limits coherence (review follow-ups)
- [x] composition limits were accepted but inert. Now: `callTimeoutMinutes` is REJECTED on a composition
      (it makes no direct calls -- set it on the sub-routines); `runTimeoutMinutes` is ENFORCED as a
      whole-flow wall-time budget (checked before each sub-routine) and SHOWN in inspect.
- [x] `runTimeoutMinutes` now also enforced on text runs (was inert there) -- one rule: it bounds any
      run's wall-time (text / loop / composition). Inspect shows both bounds on every execution routine.
- [x] checks now honor the configurable per-call bound: threaded effectiveCallTimeoutMs into
      CheckRunner.run; removed the hidden CHECK_TIMEOUT_MS (5m) constant -- the same anti-pattern this
      increment removed for calls. "none" -> unbounded checks. README's "a hung call or check" is now true.
      TRADE-OFF: one knob (callTimeoutMinutes) governs both calls and checks; a separate
      checkTimeoutMinutes is deferred (YAGNI). Default 30m covers both.
- [x] CONTRACT-V2 destaled (was framed as "proposal, not yet built" / "confirm before I build").
- [x] 132 tests, typecheck clean. Real inspect confirms: composition shows "whole run 120m" only; a
      text routine shows "per call 45m, whole run 120m".

## Increment 11 COMPLETE — signal-aware cancellation (Ctrl-C)
- [x] AbortSignal threaded bin -> proc -> adapter/check -> executors. spawnCapture kills the in-flight
      child on abort (and won't spawn if already aborted); the adapter throws and a check returns a
      flagged result on abort.
- [x] executors check the signal cooperatively (before each step / iteration / sub-routine) AND treat an
      in-flight subprocess killed by abort as a cancel, not a failure -> "cancelled" status on all three
      receipt kinds. A sandboxed run still discards its worktree in `finally`; a cancelled flow propagates.
- [x] FOUND+FIXED while validating: an aborted CHECK returns a flagged result (doesn't throw), so converge
      missed it for maxIterations=1 (ended "did-not-converge"). Now a signal that fired during an iteration
      is treated as a cancel.
- [x] bin: first SIGINT aborts (kills active step, discards sandbox, writes receipt, exit 130); a second
      SIGINT force-exits.
- [x] REAL end-to-end smoke (no claude): a check-only `sleep 30` routine, real SIGINT at 4s -> in-flight
      sleep killed immediately, run "cancelled", worktree discarded (none left), 0 stray temp dirs, exit 130,
      cancelled receipt persisted.
- [x] 144 tests, typecheck clean.

## Increment 12 COMPLETE — E2E acceptance matrix (real git, faked model)
- [x] src/acceptance.test.ts: every routine shape driven through the real CLI (runCli) against a REAL
      git-worktree sandbox and REAL checks, with only the model call faked (a stub that writes files for
      read-write participants, so real diffs/applies happen). 7 cases:
      text (cwd, no sandbox) / single-pass sandboxed dry-run (origin untouched) / single-pass --apply
      (origin written) / loop (check fails -> model fixes -> converges iter 2 -> applies) / check-only
      (passing check, no changes) / composition (grill text -> impl sandboxed, output forwarded, applied) /
      interrupted (pre-aborted -> cancelled, worktree discarded, exit 130).
- [x] all 7 green first try; full suite 151 tests, typecheck clean; no leftover worktrees, 0 temp husks.
      The shape is boring and reliable across the real cases.

## Increment 13 COMPLETE — persisted execution timeline (receipts + trace)
- [x] every step/check/iteration/sub-run receipt now carries an absolute `startedAt` (deps.now()); with
      the run's startedAt that is a real timeline (offset = startedAt - run.startedAt). elapsedMs is the
      duration.
- [x] "what was active when cancelled": cancel now RECORDS the active step (status "cancelled") and the
      partial converge iteration, so trace shows where the run was when it stopped (failed already did).
- [x] trace renders the timeline: each step/iteration shows "+<offset>ms <duration>ms" and its status.
      Real smoke: a check-only routine traced as "iteration 1 +0ms checks passed / wait check ok +0ms 320ms".
- [x] receipt-level assertions added: unit (run startedAt monotonic; converge cancel records the active
      step) + acceptance (loop timeline, composition sub-run links persisted, cancelled receipt). Acceptance
      newRunId is now a per-run counter so a flow's sub-receipts no longer collide.
- [x] 151 tests (406 expects), typecheck clean, no leftover worktrees / temp husks.

## NEXT: routine scaffolding (`chit init`)
- deferred E2E gaps (per review): failure-case acceptance cases (did-not-converge / failed text / flow
  sub-run fails / --apply non-converged never writes); in-flight (not pre-aborted) Ctrl-C in the matrix
  (mechanism already covered by proc.test + a manual smoke); apply-conflict on a dirty origin; one optional
  real-claude smoke outside CI.
- deferred follow-ups: HARD run deadline (wire runTimeoutMinutes to the cancel signal); a dry-run/cancelled
  sandbox receipt still stores its (removed) workDir path -- trace does not render it (minor, per review).

## Deferred still
durable resume, richer receipts, parallel fan-out, nested composition / multiple sandboxed
steps (shared-flow-sandbox), `repeat.from`.

## Not in scope (deferred on purpose)
Studio, MCP, plan/batch, a config editor, multi-provider adapters, routine composition,
durable resume, live progress. (Per-participant `filesystem` maps to a claude permission
mode -- claude-level, not an OS sandbox; converge WRITE safety is enforced by the
disposable git worktree.)
