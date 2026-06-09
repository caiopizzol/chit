# Sequential plan-runner (design note)

Status: design only. No code. This note is concrete enough to slice into
implementation later, but it implements nothing.

The plan-runner lets chit drive a multi-step feature plan to completion: run
step 1, let the operator approve and apply it, run step 2 on top of step 1's
applied code, and so on. It is the missing layer between a single converge run
and a parallel batch. It stays inside chit's identity: a declared routine runner
with receipts, no hosted scheduler, no model-decided graph mutation, no
auto-merge.

## 1. The problem it solves

`chit_start` converges on **one** slice in one worktree (`server.ts:1284`). A
real feature is usually a chain: schema, then the endpoints that use the schema,
then the UI that calls the endpoints. Driving that chain today means the operator
holds the sequence in their head and runs, by hand, per step:
`chit_start` -> `chit_wait` -> review -> `chit_apply` -> `chit_start` the next
one. The orchestration lives in a human, not in a declared file, and nothing
records it as one unit of work.

`chit_batch_start` looks like the answer but is not, for the sequential case. A
batch is parallel-first, and its `dependencies` are a **launch gate only**: every
task worktree is cut from the single batch `baseSha` (`engine.ts:444`), and a
dependent task "does NOT receive its dependencies' changes (no merge)"
(`batchTaskSchema`, `server.ts`; `types.ts:66-71`). So a code-dependent step
launched after its dependency reaches `review_ready` still starts **blind to the
dependency's code**. The `baseSha` comment in `types.ts:146-148` warns about
exactly this class of silently-wrong-base error. Batch is correct for
independent, path-disjoint work; it cannot express "step 2 builds on step 1's
code."

The gap the plan-runner fills: **a declared, reviewed, sequential plan where each
step's worktree is cut from a base that includes the prior step's applied diff,
with the operator gating every forward flow.**

## 2. The core invariant

A plan is an **explicit, reviewed file** - an ordered list of steps with declared
dependencies, the same way a manifest is a declared DAG (`README.md:50`,
"Manifests are static DAGs"). The plan-runner reads the plan and runs it. It
never:

- adds, removes, or reorders steps because an agent decided to mid-run;
- spawns a step that is not in the declared plan;
- flows one step's diff into another without an explicit operator-confirmed apply.

This is the `roles.md` line held verbatim: "Dynamic authoring, static execution.
The graph is still a file you read before it fires" (`roles.md:198-204`). A
planner that *generates* a plan is a later, separate concern (§9); v1's plan is
operator-authored.

## 3. Plan shape (v1)

A plan is a JSON file, consistent with chit manifests. Conceptual structure:

```jsonc
{
  "schema": 1,
  "id": "add-auth",            // optional; a uuid is generated if absent
  "title": "Add session auth",
  "baseBranch": "main",        // the plan base; the integration branch is cut from here
  "steps": [
    {
      "id": "schema",
      "title": "Add users table + migration",
      "body": "…the brief handed to the converge implementer…",
      "dependsOn": [],          // step ids; [] = depends on the plan base only
      "requiredChecks": [{ "command": "bun", "args": ["run", "check"] }],
      "manifestPath": "…",      // optional converge manifest override (else the bundled default)
      "maxIterations": 5,
      "callTimeoutMs": 900000
    },
    {
      "id": "endpoints",
      "title": "Add login/logout endpoints",
      "body": "…",
      "dependsOn": ["schema"]   // launches only after `schema` is APPLIED to the integration branch
    }
  ],
  "apply": "gated",            // v1: the only legal value (every apply needs operator confirm)
  "cleanup": "after_apply"     // retire a step's worktree once it is applied; "manual" keeps it
}
```

Field meaning, and the one place this differs sharply from a batch:

- **`dependsOn` means a code dependency, not a launch gate.** In a plan, "B
  depends on A" means *A's diff must be applied and committed to the integration
  branch before B launches*, so B's worktree is cut from a commit that contains A
  (§4 step 4). This is the inverse of batch `dependencies` (a gate that does not
  merge). Steps with no `dependsOn` relation between them are independent.
- **Acceptance checks** = `requiredChecks` per step, reusing the existing
  `RequiredCheck` shape (`jobs/types.ts:100`) and precedence model. chit runs them
  itself and treats the result as ground truth (`operating-long-running-runs.md`,
  "Always gate on required checks").
- **Apply policy** is fixed to `gated` in v1 (§10). The field exists so a future
  `auto-on-clean` is additive, not a schema break - but auto-apply is rejected for
  v1 because it would flow a diff with no human in the loop.
- **Cleanup policy**: `after_apply` (default) retires each step worktree once its
  diff is in the integration branch; `manual` keeps every worktree until
  `chit_plan_cleanup`.
- **Operator approval points** are not a field; they are structural (§5): the plan
  pauses at every gate by construction.

Parsing follows the manifest split: a browser-safe `parsePlan` in core validates
structure and the dependency graph (acyclic, ids unique, `dependsOn` references
exist) the way `planTasks` does for a batch (`batches/plan.ts`). Node-side
resolution (manifest paths, registry) layers on top.

## 4. Execution semantics

The plan-runner is a thin coordinator, modelled on the batch engine
(`engine.ts:1-10`): it owns no execution. Each step is run by the existing
converge machinery; the plan only decides **what runs next and what base it is
cut from**.

The mechanism is an **integration branch**: a chit-managed branch cut from
`baseBranch` at plan start, living in its own managed worktree (never the
operator's checkout). It is the plan's accumulating result and its primary
reviewable artifact. The base a dependent step is cut from is **a commit SHA on
this branch**, never a dirty working tree - which is why apply alone is not
enough (see step 4).

Per step, in dependency order:

1. **Cut and run.** The step's converge run is launched in its own worktree, cut
   from the integration branch's **current tip commit** (so it contains every
   already-applied-and-committed dependency). For a single runnable step this is a
   background `chit_start`-style run; the run is gated on the step's
   `requiredChecks`.
2. **Wait + review.** The run converges to a terminal stop. The operator reviews
   the diff and receipt (§6).
3. **Gated apply (stages only).** On operator confirm, the step's diff is applied
   **into the integration worktree**. This reuses the exact apply path -
   `applyRunWorkspace(git, { worktreePath, baseSha, target, confirm, includeUntracked })`
   (`server.ts:2249`) - with `target` = the integration worktree. Tracked changes
   go through git's 3-way and are refused whole on conflict (never an overwrite),
   exactly as `chit_apply` documents (`server.ts:2140`). Be precise about what
   this primitive does and does not do: it runs `git apply --3way` (tracked
   changes land **staged**) and `cpSync`es the named untracked files (they land
   **unstaged**) (`worktree.ts:559-596`); it **does not commit**, so the
   integration branch tip has not moved yet.
4. **Commit -> advance the tip.** This is the missing step the apply primitive
   does not perform, and it is the plan-runner's own work. After the apply
   succeeds, the plan-runner stages everything (`git add -A` in the integration
   worktree, to also pick up the unstaged untracked files) and **commits** one
   commit per applied step on the integration branch (message references the step
   id + its `run_id`/`audit_ref`). It records the resulting **commit SHA** on the
   step's plan record. Only now has the tip advanced. Dependents whose
   dependencies are all committed become runnable and are cut from that recorded
   SHA - so "step 2 sees step 1" rests on a durable commit, not on staged changes
   in a working tree. The commit is part of the same operator-confirmed advance,
   so no diff is committed without the gate.

**When a single run vs a batch:**

- A strict chain (each step depends on the prior) is a sequence of single
  background runs with an apply between each - this is v1 (slices 1-2).
- A **wave** of steps that are mutually independent (no `dependsOn` relation) and
  path-disjoint can run in parallel as a batch from the same integration tip, then
  be applied in sequence at the gate. This reuses the batch engine and is slice 3,
  not v1.
- A dependent step **must wait for its dependency to be applied** - not merely
  `review_ready` - because batch dependencies do not merge diffs (§1). This
  apply-between-steps is the whole reason the plan-runner exists; it is not
  gold-plating.

**Rejected shortcut (named, per the constraints):** chaining worktree branches
directly - cutting step N+1 off step N's branch to skip the apply - would flow
step N's code into N+1 with *no operator gate*. That is a silent diff merge and
breaks the no-auto-merge invariant. The explicit gated apply into the integration
branch is what keeps a human on every forward flow. We do not take the shortcut.

## 5. Operator gates

The human is in control at four points, all structural:

1. **Before it fires.** `chit_plan_start` is a dry run by default: the
   operator reviews the normalized plan, resolved base commit, and approval
   hash before calling it again with `confirm: true` and the matching
   `approval_hash`.
2. **After each step is terminal.** Review the step's worktree diff and receipt;
   approve or reject. The plan does not advance on its own.
3. **At apply.** The forward flow is a gated apply: a dry run reports the tracked
   files, whether they apply cleanly to the integration branch, and untracked
   candidates, and applies nothing; `confirm: true` applies. Same dry-run-then-
   confirm contract as `chit_apply`.
4. **At cleanup.** `chit_plan_cleanup` is dry-run by default and removes managed
   worktrees + branches only on confirm, keeping all receipts - mirroring
   `cleanupBatch` (`engine.ts:245-334`).

What happens on each non-clean step outcome (mapped to the converge/batch
vocabulary in `types.ts:41-61`):

- **revise** is an iteration-level verdict handled *inside* the converge run; the
  plan never sees it. The plan sees only the terminal stop.
- **needs_human / needs_attention** (reviewer blocked, approved-but-unverified,
  or ran out of iterations): the plan pauses at this step with status
  `needs_human`. The operator decides: fix and rerun the step, raise its budget
  and rerun, or abort. The plan never applies or advances past it.
- **failed** (worker died, run threw, worktree error): same pause; the operator
  inspects (including `partialWork`, §7) and reruns or aborts.
- **cancelled**: the plan settles cancelled; in-flight runs settle in the
  background; worktrees are kept for inspection.

Because dependents are cut from the integration tip, a paused step blocks exactly
its transitive dependents and nothing else - independent later steps can still
proceed once the operator advances.

## 6. Receipts and auditability

The plan receipt is a read-only join (like `describeBatch`, `engine.ts:574`) over
the plan record and the live runs. It surfaces, per plan and per step:

- **Plan**: `plan_id`, status, `baseBranch`, the integration branch + its current
  tip commit sha, the base-sha chain (which integration commit each step was cut
  from), `nextAction`.
- **Per step**: `run_id` (or `batch_id` for a wave step), step status, the live
  `runState`/`phase`/`activity` for an in-flight run and the `lastVerdict` /
  `lastVerification` / `lastVerificationSource` once it settles (reuse the batch
  task view fields, `engine.ts:504-528`), `changedFiles`, `auditRefs`.
- **Step receipt** (settled steps only): once a step is terminal, its
  `chit_plan_status` row can carry a compact `receipt`, snapshotted from the step's
  loop log at settle and surfaced straight from the plan record - so the row still
  answers "what happened?" after the live job join is gone (`engine.ts:743-746`,
  `types.ts:131-136`). It is the same safe `LoopReceipt` shape the single-run views
  use (`status-line.ts:73`): compact evidence, not a transcript. When present it
  carries `status` (the loop's terminal stop status), `iterationsCompleted`,
  `statusLine` (the latest iteration's compact line), `changedFiles`,
  `workspaceWarnings`, `latestChecks`, `verification` + `verificationSource`,
  `usage`, `auditRefs`, `stopReason`, and `elapsedMs`. It holds no participants,
  env values, prompts, outputs, or blob bodies - that provenance lives in
  `participants` on the row, not here. The receipt is recorded only at settle from a
  readable loop log, so a row has none in three cases: a running step (not settled
  yet), a settled step whose loop log was unreadable or held no records at settle
  (`server.ts:2765-2792`), and a legacy record predating receipts.
- **Apply result** per applied step: which tracked files landed (staged) and which
  untracked files landed (unstaged), and any conflict refusal - the exact
  disclosure `chit_apply` already returns (`server.ts:2256-2259`) - plus the
  **integration commit sha** the advance produced after committing the staged work
  (§4 step 4). That sha is the durable handle a dependent is cut from; recording it
  is what makes "step 2 sees step 1" auditable rather than implied.
- **Cleanup receipt**: which worktrees/branches were retired, with `receiptsKept:
  true` - the plan/run/audit records survive cleanup, so `chit_trace` and
  `chit_audit_show` keep working (`engine.ts:286-290`).

The three altitudes stay distinct. `chit_plan_list` stays a one-line-per-plan
summary and never carries receipts. `chit_plan_status` carries the compact step
receipt for a settled step when its loop log produced one. The raw loop history,
including every iteration record, still lives in `chit_trace`, keyed by `run_id`.
The receipt is a companion to that history, not a replacement: it settles "what
happened?" from the plan view alone, and you open the full trace, or a step's
transcript with `chit_audit_show { audit_ref }`, when you need more.

The plan record points; it never recomputes execution or duplicates transcripts -
the same discipline the batch and job records hold (`types.ts:11-15`,
`jobs/types.ts:10-13`).

## 7. Safety and recovery

- **Dirty checkout.** The integration branch lives in a chit-managed worktree cut
  clean off `baseBranch`; the operator's checkout is never the apply target during
  the plan. Applies use git's 3-way and are refused whole on conflict, so no edit
  is ever overwritten (`server.ts:2140`).
- **Linked-worktree launch.** The plan record must anchor its durable cleanup
  `repo` on `mainRepoOfWorktree` (the repo owning the shared `.git`) and keep the
  launching checkout separately as `callerCheckout` - the fix the batch needed in
  `investigation-batch-recovery-0.32.md` scenario 5 and now does
  (`engine.ts:138-143`, `types.ts:129-142`). The plan-runner adopts this from day
  one rather than repeating the bug.
- **Timeout.** Each step is a background run with its own wait/timeout; the plan
  does not hold the chat. A `chit_wait` extended to accept a `plan_id` blocks until
  a step finishes or a gate is reached; Esc stops the wait, not the runs
  (`operating-long-running-runs.md`, "Wait: block, don't poll").
- **Partial work salvage.** A failed step can leave uncommitted work in its
  worktree that no iteration captured; surface it via `partialWork`
  (`types.ts:88-92`, `engine.ts:425-430`) so it is findable, not assumed lost.
- **Closed-session recovery.** A durable **Plan record** (one file per plan, keyed
  by `plan_id`, under the state dir namespaced by repo) is the source of truth,
  mirroring `JobStore`/`BatchStore`. `chit_plan_list` recovers a lost `plan_id`.
  Recovery resolves the integration branch and each step's run from the plan +
  job records, **never from a loop log alone** - the loop log is keyed by `loopId`,
  not `run_id`, and carries no workspace for background runs
  (`investigation-batch-recovery-0.32.md` scenarios 1, 4). As long as the job
  records live (nothing prunes them today, scenario 6), apply/cleanup by id work.
- **What must never happen silently:** applying a diff, advancing the integration
  tip, retiring a worktree that holds unapplied work, skipping/reordering a step,
  continuing past a non-clean or rejected step, or running a step absent from the
  declared plan. Each is gated or impossible by construction.

## 8. MCP surface (small v1)

A new tool family that mirrors the batch family one-for-one and **composes**
existing tools rather than replacing them:

| Tool | Inputs | Output | Composes |
|---|---|---|---|
| `chit_plan_start` | `plan` or `plan_path`, `cwd?`, `base_branch?`, `max_iterations?`, `confirm?`, `approval_hash?` | dry run (default): `launched:false`, the normalized plan, resolved `base`, and `approvalHash`. Confirmed: `plan_id` + plan view | dry run resolves the base and hashes the approval; a confirmed launch starts the first step like `chit_start` |
| `chit_plan_list` | `cwd?`, `limit?` | one-line summary per plan (id, status, step counts, `cleanedAt`) | the `listBatches` pattern (`engine.ts:733`) |
| `chit_plan_status` | `plan_id`, `cwd?` | read-only plan view | join over plan + job records |
| `chit_plan_advance` | `plan_id`, `apply?: { step_id, confirm, include_untracked? }` | updated view (incl. the integration commit sha on apply) | the gated apply uses `applyRunWorkspace` (the `chit_apply` core), then **commits** the staged work to the integration branch, then launches newly-unblocked steps |
| `chit_plan_cancel` | `plan_id` | view | `chit_cancel` per active run |
| `chit_plan_cleanup` | `plan_id`, `confirm` | cleanup result | the `cleanupBatch` pattern |

`chit_plan_list` is the lost-`plan_id` recovery path, exactly as `chit_batch_list`
is for batches (`server.ts:2474`); read-only over the plan store.

Notes:

- **`chit_plan_start` is universally gated by approval.** With `confirm` omitted or
  false it is a DRY RUN: it parses the plan, resolves the base ref to a concrete
  `{ ref, sha }`, computes a sha256 `approvalHash` over the normalized plan plus that
  base plus the launch-time `max_iterations`, and returns `launched:false` with the
  plan, base, and hash. It creates no plan record, worktree, job, or branch. With
  `confirm:true` it re-parses, re-resolves the base, recomputes the hash, and refuses
  before any mutation unless `approval_hash` matches - so a plan, base, or budget
  edited after approval cannot launch on an old hash. On a match it launches from the
  approved commit `sha` (pinned even if the ref later moves), not the ref.
- **`chit_plan_advance` owns the apply-then-commit gate.** Folding the gated apply
  into advance (rather than asking the operator to call `chit_apply` with
  `target_cwd` pointed at the integration worktree by hand) removes a footgun while
  keeping the human confirm. The apply step is the same `chit_apply` code path, so
  its behavior and disclosure are identical; advance then adds the commit
  `applyRunWorkspace` does not do (§4 step 4) and returns the new sha. The operator
  can still run `chit_apply` dry-run on a step's `run_id` to inspect, but forward
  flow goes through advance.
- **Wait reuses `chit_wait`**, extended to accept `plan_id`, exactly as the batch
  family reuses it - no `chit_plan_wait`.
- It does not replace `chit_start`, `chit_batch_start`, `chit_apply`,
  `chit_cleanup`, or the audit tools; it sequences and gates them.

## 9. Staged implementation

Each slice lands green and shippable. Must-have v1 = slices 1-2.

1. **Plan format + record + sequential skeleton (v1).** Core `parsePlan` (browser-
   safe; graph validation like `planTasks`). A `PlanStore` mirroring `BatchStore`,
   anchored on the durable main repo from the start. `chit_plan_start` /
   `chit_plan_list` / `chit_plan_status` / `chit_plan_cancel` driving a **strict
   chain, one step at a time**, each step cut from the integration branch's tip
   commit. *Tests:* graph validation (cycles, dangling `dependsOn`, dup ids);
   sequencing order; status join; linked-worktree anchor unit test modelled on the
   scenario-5 test in `investigation-batch-recovery-0.32.md`; `chit_plan_list`
   recovery of a lost `plan_id`.
2. **Gated apply-then-commit + cleanup (v1).** Integration branch lifecycle;
   `chit_plan_advance` gated apply (dry-run -> confirm) into the integration
   worktree via `applyRunWorkspace`, **then a `git add -A` + commit** that advances
   the integration tip and records the commit sha; cut-next-from-that-sha;
   `chit_plan_cleanup`. *Tests:* the commit advances the tip and the next step is
   cut from the recorded sha (assert the dependent's base contains the prior step's
   files); a conflicting apply is refused whole and **no commit is made**; the
   commit picks up untracked files (`git add -A`, not just the staged patch); a
   paused `needs_human`/`failed` step blocks only its dependents; cleanup keeps
   receipts. *Dogfood:* drive a real 2-3 step feature plan (schema -> endpoints ->
   wiring) end to end and read the plan receipt, confirming step 2's worktree
   contains step 1's committed code.
3. **Parallel waves (later).** Independent, path-disjoint runnable steps run as a
   batch wave from the same tip (reuse the batch engine), applied in sequence at
   the gate. *Tests:* a wave runs concurrently; applies are ordered; a wave step
   failure pauses only its dependents.
4. **Studio UX + planner (later).** Plan authoring/visualization in Studio; a
   read-only **planner role** that proposes a plan for operator approval -
   "dynamic authoring, static execution" (`roles.md:188-204`). Strictly additive;
   does not change the runtime invariant.

## 10. Non-goals for v1

- **No auto-apply / auto-merge.** Every diff flows through an operator-confirmed
  apply. (`apply: "gated"` is the only legal value.)
- **No parallel waves in v1.** Sequential chain first; waves are slice 3.
- **No plan generation in v1.** The plan is an operator-authored file; the planner
  role is slice 4.
- **No daemon / scheduler / cron.** Progress happens only at explicit tool calls,
  exactly like the batch engine (`engine.ts:8-10`).
- **No mid-run graph mutation.** Steps are fixed at start.
- **No rollback/undo of an applied step.** The operator uses git on the
  integration branch directly.
- **No cross-repo plans, no GitHub PR creation or merge.** The deliverable is a
  reviewed integration branch, the same way a batch's deliverable is reviewable
  branches (`types.ts:18-19`).
