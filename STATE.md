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

## Increment 14 COMPLETE — legacy trace compat + failure-case E2E
- [x] FIXED a regression: the timeline render assumed per-step startedAt, so `chit trace` on receipts
      written before increment 13 showed "+NaNms". Reproduced on real old receipts (run-12c4ae18 etc.).
      Now the offset is omitted when a step/iteration lacks startedAt (legacy), so old receipts stay
      readable. Regression test added (a legacy receipt renders without NaN).
- [x] failure-case E2E (real git, faked model), 5 new cases:
      did-not-converge with --apply does NOT write / a throwing model call -> failed receipt + exit 1 /
      composition sub-run failure stops the flow before the sandboxed step (which never runs) /
      dirty-origin apply conflict -> --apply fails cleanly, origin uncorrupted, sandbox discarded /
      in-flight cancel -> an async abort DURING a running check cancels + discards (not just pre-abort).
- [x] 157 tests (430 expects), typecheck clean, no leftover worktrees / temp husks.

## Increment 15 COMPLETE — apply-failure leaves a durable receipt (+ stale-doc fix)
- [x] FIXED the last reliability hole: when a converged run's write-back (sandbox.apply) failed (e.g. a
      dirty origin), runConvergeInSandbox threw before the CLI could save the receipt -- so a converged
      run could leave NO evidence. Now the apply error is CAUGHT, recorded on the receipt (applyError) and
      the result; the run returns normally, the CLI saves the receipt and reports "converged, but could
      not apply" (exit 1). A flow's terminal apply behaves the same; trace renders the apply line.
- [x] tests: converge-run unit (apply throws -> receipt.applyError, not thrown, sandbox still discarded);
      acceptance dirty-origin now asserts the persisted receipt + applyError; a views render test.
- [x] fixed stale STATE "Not in scope" (it still listed routine composition + live progress, both built).
- [x] 159 tests (439 expects), typecheck clean, no leftover worktrees / temp husks.

## Increment 15.1 — flow apply-failure visible from the flow run id (review follow-up)
- [x] 15 fixed standalone runs, but the FLOW receipt did not carry applyError, so `chit trace <flowRunId>`
      (the id the CLI points the user to) showed "completed" with no apply failure -- only the terminal
      sub-receipt had it. Now FlowReceipt carries applyError, runFlow persists it, flow trace renders it.
- [x] acceptance: a composition with a dirty-origin terminal apply -> exit 1, origin uncorrupted, the FLOW
      receipt has applyError and formatTrace(flowReceipt) shows the apply line. 160 tests, typecheck clean.

## Increment 16 COMPLETE — `chit init` scaffolding
- [x] src/scaffold.ts: `chit init [<name>] [--template text|loop|check]` writes a runnable manifest from a
      template under examples/, registers it in chit.config.json (creating it if absent), prints next steps.
      Templates map to the three first-routine shapes (text / sandboxed loop / check-only); loop+check use
      an `sh -c "true # replace with your real check"` placeholder so a fresh scaffold runs green and
      self-documents.
- [x] the generated manifest is REAL: scaffold.test resolves all three templates and RUNS the text one end
      to end; cli.test does init -> routines -> run through the CLI. Name validated kebab-case (config's
      rule); duplicate name / existing manifest rejected; existing config preserved (raw-JSON merge).
- [x] README documents the verb + layout. 168 tests (468 expects), typecheck clean, no husks.
- note to self: a careless smoke ran `init` in the repo root and polluted chit.config.json + examples/
  (TWICE now); reverted via git checkout both times. For manual init smokes use a subshell:
  `( cd "$tmp" && bun run <abs>/src/index.ts init ... )`. Tests use temp cwds, so they are safe.

## Increment 16.1 — init validates an existing config (review follow-up)
- [x] FIXED: init did not validate an existing chit.config.json before mutating it. A parseable-but-invalid
      shape like {"routines":[]} (array) bypassed the undefined check, and JSON.stringify silently drops a
      named property set on an array -- so init reported success while the routine was never registered and
      the config stayed invalid (the scaffold was unrunnable). Now init validates the existing config with
      parseConfig BEFORE writing anything: a malformed config is rejected (exit 1, clear message) and
      nothing is written (atomic). Regression test + a careful subshell CLI smoke confirm it. 169 tests.

## Increment 17 — read-only adapter returns real output (real-E2E fix)
- [x] REAL model-backed E2E exposed it: a composed feature-flow failed because the planning step produced
      0 chars -> impl's `task` input was empty -> "missing required input task". Root cause: the adapter
      mapped read-only -> `claude -p --permission-mode plan`. Plan mode is the plan-then-approve flow; under
      `-p` it can route the answer through ExitPlanMode and return empty stdout (non-deterministic).
- [x] FIX (adapter only, manifest model unchanged): read-only -> `claude -p --permission-mode default
      --disallowedTools Edit Write NotebookEdit`. Confirmed by a side-by-side test: default mode reliably
      inspects + answers; plan mode was the unreliable one.
- [x] VERIFIED with real claude: feature-griller -> 8604 chars, planning -> 6584 chars of repo-grounded
      output (the plan grep'd for color and found the CliDeps out/err seam); git stayed clean -- read-only
      wrote nothing (the disallowed edit tools held).
- [x] guarded real-claude smoke (src/real-smoke.test.ts): skipped by default (CI stays fake-backed), runs
      with CHIT_REAL_SMOKE=1; asserts grill + planning return non-empty output. README mapping updated.
- [x] 169 pass + 2 skip, typecheck clean.
- [x] FULL composed flow re-run PASSED with real claude: feature-flow (grill -> plan -> impl) REACHED impl
      (no more "missing required input task"); impl converged in 1 iteration -- the builder added a working
      `chit version` command, real `bun run typecheck` + `bun test` both passed in the sandbox; dry-run
      discarded; origin untouched, no leftover worktree, 0 husks (run-356598da). The composed orchestration
      model is now proven with REAL model outputs, not just fakes.

## Increment 17.1 — read-only is ACTUALLY read-only (review follow-up)
- [x] the increment-17 mapping disallowed Edit/Write/NotebookEdit but LEFT Bash, so a model could still
      `echo > file` -- read-only was not read-only. Verified the hole with real claude (it created
      created.txt). FIX: add Bash to the disallowed list. Re-verified real: the write is now BLOCKED and
      reading STILL works (the model read before.txt via the Read tool and returned its contents -- read
      tools don't need Bash). Added a guarded real-smoke that a read-only call cannot create a file;
      README corrected to "every write tool disallowed (edit tools AND the shell)". 169 pass + 3 skip.
- [x] guarded smoke (CHIT_REAL_SMOKE=1) PASSED 3/3 against shipped code: grill + planning return output,
      and a read-only call cannot create a file; repo clean after. read-only is now genuinely read-only.

## Increment 18: configurable agents (the core promise)
- [x] the gap: manifests said participants have `agent: "claude"` but the adapter THREW for anything else,
      so the agent/model binding was not actually flexible. Fixed WITHOUT touching the manifest model.
- [x] config gains an `agents` registry { <id>: { adapter, model? } }. A participant names an agent id;
      resolveRoutine binds it to the config entry and FAILS at resolve if the id is undefined.
- [x] dispatchingAdapter (built at the CLI layer from config.agents + an adapter registry) routes each call
      to the configured adapter + model; the executors are unchanged (they call one adapter). Unknown agent
      id / unwired adapter type fail cleanly. claudeCliAdapter passes --model (skipped for "default").
- [x] inspect shows the binding per participant ("builder -> claude"); receipts/trace already record the
      agent id per step. implementation-review now uses two profiles (builder/critic) to demonstrate it;
      chit init registers the agent it scaffolds. index wires adapters: { claude: claudeCliAdapter }.
- [x] tests: agents.test (dispatch routing/model/errors; resolve binding + missing-agent; two participants
      -> different adapters; composition output across different agents), config agent parsing, inspect
      binding; + a guarded real smoke (two claude profiles; read-only can't write; read-write edits only in
      the sandbox; receipt names each agent). 183 pass + 4 skip, typecheck clean.
- [x] guarded smoke (CHIT_REAL_SMOKE=1) PASSED 4/4 against real claude: read-only routines return output, a
      read-only call cannot write, and the two-agent routine ran builder (read-write) + critic (read-only)
      with the receipt naming each agent and origin untouched. Configurable agents proven with real models.

## Increment 18.1: agent observability + smoke reliability (review follow-ups)
- [x] receipts now record the RESOLVED binding per call step (agent id + adapter + model), so trace proves
      what ACTUALLY ran, not just the profile id; trace renders "call builder (claude:sonnet)" (the model is
      shown only when non-default). agents.test asserts the per-step adapter; views.test asserts the render.
- [x] raised the guarded real-smoke timeouts (180s -> 600s): a real grill/plan call can exceed 3 min, and a
      reviewer's independent smoke timed out at 180s. Corrected the two-agent smoke name -- it proves builder
      edits only the sandbox and the receipt names each agent; the SEPARATE test proves read-only can't write.
- [x] 184 pass + 4 skip, typecheck clean.

## Increment 18.2: multi-model proven; second-adapter feasibility scouted
- [x] multi-model: a participant can pick its model. Always-on test -- two profiles on the SAME claude
      adapter with different models route the right model per step and the receipt records each. Confirmed
      real: `claude -p --model sonnet` returns output, so the dispatcher's --model passthrough is genuine.
      The guarded two-agent smoke now uses two MODELS (builder=sonnet, critic=haiku) and asserts each binding.
- [x] second real adapter scouted (do NOT ship unverified): `codex exec` and `gemini -p` both exist and run
      non-interactively. gemini is closest to claude (-p / -m / --approval-mode default|auto_edit|yolo|plan)
      but needs `--skip-trust` (or GEMINI_CLI_TRUST_WORKSPACE=1) headless. NEXT slice: a geminiCliAdapter with
      its OWN empirical permission-mapping verification (read-only must ACTUALLY be read-only, the same check
      claude needed), wired as { claude, gemini }; then a real builder-on-claude / critic-on-gemini smoke.
- [x] 185 pass + 4 skip, typecheck clean. Guarded multi-model smoke PASSED 1/1 against real claude: a
      sandboxed loop with builder=sonnet + critic=haiku converged, the receipt recorded each adapter/model
      binding, origin untouched. Multi-model is proven end to end (different models per participant).

## Increment 19: a second real adapter (gemini) -- multi-backend proven
- [x] also (review follow-up): every call receipt (ok/failed/cancelled) now names the agent, not just the
      adapter/model -- callBinding carries the agent id. Failed-call test asserts it.
- [x] geminiCliAdapter, with its permission mapping EMPIRICALLY verified FIRST (the claude lesson):
      `gemini --skip-trust -p` returns clean stdout (the "Ripgrep" notice is stderr); `--approval-mode plan`
      is genuinely read-only (returns output AND cannot write a file); `yolo` auto-approves writes; `--model`
      selects the model. Wired as adapters: { claude, gemini }.
- [x] guarded smokes PASSED 2/2 against real models: a gemini read-only call cannot create a file; and a
      MIXED run -- builder on CLAUDE (read-write, sandboxed) + critic on GEMINI (read-only) -- converged, the
      receipt recorded both bindings (build->claude, review->gemini), origin untouched on the dry run.
- [x] the adapter abstraction is real: a second backend was one registry entry + one verified mapping, no
      redesign. 186 pass + 6 skip, typecheck clean.

## Increment 20: literal CLI-process E2E (operator path)
- [x] the suite called runCli() directly; added src/cli-process.test.ts that SPAWNS the real binary
      (`bun src/index.ts ...`) in a temp cwd and asserts exit codes + output -- the operator's actual path:
      argv parsing, process.exit codes, the bin's adapter-registry wiring, the no-config / unknown-command
      paths. Deterministic, no model (init -> routines -> inspect; usage; unknown command -> 2; run unknown
      -> 1; run with no config -> 1). A guarded case runs a real routine through the binary. 191 pass + 7 skip.
## Dogfood pass 1 -- feature-flow through the real binary (framework unchanged)
Ran a genuine task: `chit agents` command, via `bun run src/index.ts run feature-flow --input idea=...`,
dry-run. grill(3m) -> plan(3.5m) -> impl(12m), ~18.5m total. It SUCCEEDED: the model wrote a real
implementation (formatAgentList + AgentListItem + a cli command + tests + docs), real typecheck+test passed
in the sandbox, converged iter 1, dry-run discarded, origin clean. The observability fix paid off -- trace
shows `call builder (claude)`, the checks, and a diffstat. Friction, ranked:
1. NO HUMAN-INPUT / decision gates (the big one). grill->plan->impl is fully automated; the operator can't
   refine the idea after grilling, approve/adjust the plan before a 12-min impl, or veto choices. The model
   made ALL decisions -- it even edited STATE.md + README (the dev's own log/docs), which an operator would
   want to scope out BEFORE implementing. This is the predicted gap, confirmed.
2. The builder edits broadly (7 files / 140 lines for "add a command"); no scoping except via prompt text.
3. Long runs are a black box: ~18.5m, no progress magnitude/ETA; one builder call took ~9m with no in-call
   progress.
4. trace is good per-run but not aggregated: the FLOW trace shows only sub-run ids (drill in for models/
   changes), and neither says "what to do next" (the --apply hint the CLI output gives).
5. inspect of a composition doesn't show the agents the flow uses; live progress shows the agent id, not the
   resolved adapter/model.

CONCLUSION (smallest justified next feature): HUMAN-INPUT STEPS. Shape the dogfood revealed: a step kind that
pauses to ask the operator a structured question and feeds the answer forward (decision gates between steps:
"refine the idea?", "approve/adjust the plan before implementing?"). Implement via an injectable askUser seam
(deterministic in tests; the bin reads stdin), like the adapter/checkRunner seams.

## Increment 20: human-input gates (`ask` steps) -- the dogfood fix
A new step kind `{ id, ask: "<question>" }`. It pauses, asks the operator one question (which can template in
earlier output, e.g. `{{ steps.plan.output }}`), and feeds the typed answer forward via the existing
`{{ steps.<id>.output }}` -- no new plumbing for feed-forward. Fourth injected seam `deps.askUser(question)`,
exactly like adapter/checkRunner/sandboxFactory: the bin reads stdin (a shared, abort-aware readline -- Ctrl-C
at a prompt cancels the run), tests inject a deterministic answer.
- SCOPE (feed-forward only, deliberate): the answer shapes later steps ("refine", "adjust the plan"). NO
  manifest-level halt/veto -- a hard "no" is still Ctrl-C (writes a clean `cancelled` receipt). Halt is new
  control flow; deferred until a 2nd dogfood justifies its shape.
- WHERE (Rule 4): `ask` is allowed in text routines and compositions (execution pauses cleanly between steps),
  and FORBIDDEN in a sandboxed/looping routine (a check step or read-write participant). One notch stricter
  than the reviewer's "no ask in repeat loops": the converge executor is shared by repeat and non-repeat
  sandboxed runs, so excluding the whole sandbox path keeps that executor untouched and sidesteps
  ask-once-vs-every-iteration entirely. A sandboxed routine that needs a gate gets it in the composition that
  calls it -- exactly the dogfood shape (grill -> plan -> approve -> impl).
- RECEIPT BOUNDARY (verified the reviewer's point against the code): per-step transcripts are already never
  stored (store.ts); the `ask` step receipt carries status + timing only, never the answer. `output` cannot
  name an ask step, and the implicit output skips ask -- so an answer never becomes the persisted run output
  unless the operator explicitly formats it forward.
- DOGFOOD FIX SHIPPED: examples/feature-flow.json gained an `approve` gate between `plan` and `impl` (the exact
  friction #1). New model-less examples/clarify.json demos the mechanic and backs a deterministic
  real-binary stdin E2E.
- VERIFIED: +29 tests (manifest Rule 4 + ask parsing + output rule; runOneShot ask incl. cancel + no-handler +
  output-skip; flow gates incl. feed-forward + no sub-run + cancel; views inspect/trace render; a process E2E
  that pipes stdin to the real bin). Manual: `printf 'Ada\n' | chit run clarify` -> output uses the answer,
  trace shows `name ask ok` with no body. 220 pass + 7 skip, typecheck clean.
- COMPOSABILITY FIX (reviewer-caught, reproduced first): runFlow forwarded onProgress/signal into a one-shot
  sub-run but NOT askUser, so a composition calling a TEXT sub-routine that has its own ask gate failed ("no
  input handler wired") even with stdin provided -- a text-routine-with-ask behaved differently composed vs
  standalone. Fixed by forwarding askUser into runOneShot from runFlow; added a test (composed == standalone,
  answer reaches the sub-run output, ask step still bodyless).

## Increment 21: a generic loop primitive (`repeat.until`), so /goal is authored, not built
The remaining opinionated part was `repeat.until: "checks-pass"` -- loops could only end when command checks
passed. Generalized so the routine declares WHEN the loop ends; /goal, grilling, research-until-good are now
user-authored routines, not product concepts. `repeat.until` is now `"checks-pass"` (unchanged default) OR
`{ step, equals }` -- a named step's (trimmed) output equals a string (e.g. an evaluator call returns "yes").
- LOOP / SANDBOX DECOUPLED (the real architectural work): `repeat` no longer implies a check, so a loop is no
  longer always sandboxed. runConverge was already the pure loop (runConvergeInSandbox just wraps it with a
  worktree), so dispatch now routes a non-sandboxed loop (read-only, no checks, a `{ step, equals }` exit) to
  runConverge IN THE CWD -- in cli.ts AND flow.ts (a flow sub-routine can be a text loop). Critical: relaxing
  the rule without fixing dispatch would have let a check-less loop silently route to runOneShot and run ONCE
  (a manifest that parses but doesn't loop). Sandbox rules unchanged: write/check -> worktree.
- VERIFIED REVIEWER'S EXAMPLE WAS INVALID: their /goal sample put a `routine` step inside the loop (a
  composition + repeat = both forbidden). Looping a SUB-ROUTINE is a bigger, separate feature; the minimal
  generic-until is on EXECUTION loops, so /goal is authored with a `call` evaluator. Composition-looping deferred.
- DECISIONS: comparison is `output.trim() === equals` (exact, case-sensitive; the author makes the evaluator
  return the token). `maxIterations` REQUIRED for `{ step, equals }` (a judged condition has no guaranteed
  termination), optional (default 5) for checks-pass. ask stays out of ALL loops (Rule 4 now also checks
  `repeat`, since a non-sandboxed loop would otherwise slip past the old sandbox-only guard). A loop's text
  result is the declared `output`, else the last call/format step EXCLUDING the evaluator step (its verdict is
  the signal, not the product) -- on the ConvergeReceipt, surfaced for non-sandboxed loops.
- SHIPPED: examples/refine.json (draft -> critique -> repeat until "ship") -- a real model-judged, non-sandboxed
  loop. trace/inspect render the condition + a met/not-met verdict.
- VERIFIED: +17 tests (until parsing + required-maxIterations + step-exists + ask-in-loop; runConverge
  step-equals convergence incl. trim + case-sensitivity + did-not-converge + output-is-work-not-verdict;
  cli non-sandboxed-loop dispatch; flow loop sub-routine; views condition labels; a model-less real-binary loop
  E2E). 237 pass + 7 skip, typecheck clean.

## Increment 22: a third real adapter (codex), config-only
`codexCliAdapter` beside claude/gemini. No manifest change -- a participant's agent id, bound in
chit.config.json to `{ adapter: "codex", model? }`, is all it takes. Uses `codex exec` (the
non-interactive surface) and reads the FINAL message from `--output-last-message` (a clean single-message
file), NOT stdout (stdout carries progress + a token-count footer).
- VERIFIED THE CLI MYSELF (codex-cli 0.139.0, not the quoted manual): flags exist as claimed; manually
  confirmed read-only returns text, read-only CANNOT write, workspace-write CAN write (in a git repo).
- MAPPING: read-only -> `--sandbox read-only`; read-write -> `--sandbox workspace-write` (codex's sandbox is
  a SECOND boundary; converge still passes the disposable worktree as cwd, the primary safety). `none` is
  REJECTED -- codex has no true no-tools mode, and mapping it to read-only would silently grant the fs read
  that `none` withholds (more honest to fail with a clear error). `--skip-git-repo-check` lets a read-only
  call run in a non-repo cwd; `--ephemeral` keeps no session history.
- VERIFIED: +5 tests -- an unguarded `none`-rejection unit test (no model), and 4 guarded real-codex smokes
  (read-only returns text; read-only can't write; workspace-write writes; a sandboxed chit run with a codex
  builder produces a diff, dry-run discards it, receipt records adapter:codex). All 5 pass against the real
  `codex` CLI in ~68s. 238 pass + 11 skip, typecheck clean. (Gate item 5, --apply-after-checks, is the same
  adapter-agnostic git-apply path already proven; the codex dogfood would exercise it end to end.)

## Increment 23: a coherent base + a real review gate (preflight, then `chit apply`)
Two related fixes to make a sandboxed feature-flow trustworthy, both verified against the code/git first:
- PREFLIGHT (increment 23a): a sandbox is a `git worktree` from HEAD, so uncommitted origin changes are
  invisible to the run and could be clobbered on apply (confirmed empirically: a worktree from HEAD lacks an
  uncommitted edit). Any write-capable run now refuses a dirty origin upfront -- "Commit or stash your changes
  first." -- and records the base commit on the receipt. The check runs in the CLI BEFORE any model call, so a
  flow fails fast (before grill/plan), not after. A SandboxFactory.preflight seam (real git-status; fake clean
  or dirty on demand). The two acceptance tests that provoked an apply conflict via a dirty origin now assert
  the refusal -- that conflict can't happen anymore; the apply-failure handling stays covered by a fake test.
- `chit apply <run-id>` (increment 23b): the old "re-run with --apply" RE-RAN the models, producing a
  DIFFERENT diff than the one reviewed. Now a dry run stores the exact patch (.chit/runs/<id>.patch, a git
  binary diff); `chit apply <id>` re-plays THAT patch through a gate -- same base (HEAD still == the recorded
  base), clean tree, and `git apply --check` -- so you apply exactly what you reviewed. SandboxFactory gains
  patch() + applyPatch(); ApplyError carries operator guidance. The dry-run hint now points at `chit apply`.
- CAUGHT BY THE E2E: the dirty-check must exclude chit's own `.chit/` state dir (untracked receipts would
  otherwise mark a fresh repo dirty and block apply). Excluded via a `:(exclude).chit` pathspec, verified.
- VERIFIED: +9 tests incl. a model-less real-binary E2E of the FULL cycle (a check writes a file -> dry run
  stores the patch + leaves origin clean -> `chit apply` re-plays it onto the real tree) and a real-binary
  dirty-refusal. 246 pass + 11 skip, typecheck clean.

## State of the proof
The minimal model is proven end to end: one manifest shape, behavior derived from structure; text /
sandboxed-loop / check-only / composition all run through the real CLI against real git; dry-run vs
--apply; configurable limits (visible in inspect); Ctrl-C cancel; a persisted timeline; configurable
agents (adapter + model bound in config, multi-backend: claude + gemini + codex); human-input `ask` gates that
feed an operator answer forward; a generic loop primitive (`repeat.until` = checks-pass OR a model/human-judged
`{ step, equals }`, sandboxed or in-cwd) so /goal-style loops are authored not built; every run leaves a durable,
traceable receipt (including did-not-converge, failed, cancelled, and apply-conflict); and `chit init` scaffolds
a runnable first routine. 22 increments, all green.

## Optional / deferred (none blocking)
- one real-claude smoke outside CI (the suite fakes the model on purpose).
- HARD run deadline: wire runTimeoutMinutes to the cancel signal (today cooperative; Ctrl-C is the only
  mid-call abort).
- a dry-run/cancelled sandbox receipt still stores its (removed) workDir path -- JSON-only, trace does not
  render it; could mark it "discarded".
- still deferred by design: branching, an `ask` HALT/veto (today feed-forward only; Ctrl-C is the hard stop),
  ask inside a sandboxed/looping routine, looping a SUB-ROUTINE (a `routine` step inside a `repeat`; today a
  loop is over an execution routine's call/format/check steps), richer `until` forms (regex / contains /
  model-scored), nested composition, multiple sandboxed steps in a flow, parallel fan-out, durable resume.

## Deferred still
durable resume, richer receipts, parallel fan-out, nested composition / multiple sandboxed
steps (shared-flow-sandbox), `repeat.from`.

## Not in scope (deferred on purpose)
Studio, MCP, plan/batch, a config editor, multi-provider adapters, durable resume.
(Routine composition and live progress WERE here but are now built.) Per-participant
`filesystem` maps to a claude permission mode -- claude-level, not an OS sandbox;
converge WRITE safety is enforced by the disposable git worktree.
