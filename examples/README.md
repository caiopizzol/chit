# Examples

Five manifests live here on purpose:

- `consult.json` - the first-run example. Ask Codex and Claude the same question in parallel, then format both answers.
- `converge.json` - the advanced loop manifest used by `chit converge`. The default pairing: a write-capable Claude implements, a read-only Codex reviews, and the driver owns the loop.
- `converge-codex-writer.json` - the same loop with the agents swapped (a write-capable Codex implements, a read-only Claude reviews). Point a batch task's `manifestPath`, or `chit_start`'s `manifest_path`, at it to run a Codex implementer. Shows that roles are assigned in the chit, not fixed to a vendor.
- `converge-required-checks.json` - the same loop with `policy.requiredChecks`, so chit runs its own verification commands (argv, no shell) after a proceed review and treats the result as ground truth: pass converges, fail revises, a check that cannot run needs a human. Shows chit-executed verification, not the reviewer's self-report.
- `plan-author.json` - use chit to plan a sequential run. A read-only planning agent inspects the repo and drafts a native sequential plan as JSON, ready for `chit_plan_start`. It is one-shot (no loop), and it teaches a distinct shape: a manifest whose output is another chit artifact, not a code edit. The agent emits only the plan shape `chit_plan_start` accepts; the operator reviews and gates the start.

Keep this directory small. Add a new example only when it teaches a distinct runtime shape that the docs actually need.

## Planning a sequential run with `plan-author.json`

The flow, end to end:

1. Run the planner with `chit_start` (or `chit run examples/plan-author.json`), passing `goal` (and optional `context` naming a base branch or a vetted `manifestPath` override). The agent inspects the repo and returns one JSON plan.
2. Read the emitted plan JSON. It is a native sequential plan: `schema` 1, a `title`, optional `id`/`baseBranch`/`apply`/`cleanup`, and `steps` carrying `id`/`title`/`body`/`dependsOn`/`requiredChecks` and the optional `commitMessage`/`recipe`/`manifestPath`/`maxIterations`/`callTimeoutMs`. `dependsOn` is a code dependency, not a launch gate, and there is no batch task graph and no invented field. `commitMessage` is the single-line conventional commit subject the gated apply commits that step under on the integration branch (omitted, the commit falls back to `plan step <id>: <title>`); it is part of the reviewed plan, so the approval hash binds it. `recipe` selects a vetted config recipe by id (the recipe supplies the manifest and default budgets); it is mutually exclusive with `manifestPath`. A step may also declare structured `handoffs` it produces (a map of handoff id to `{ path, format: "json", maxBytes? }`, the path a worktree-relative JSON file) and `consumes` accepted handoffs from earlier steps (`{ step, handoff, as }`), bounded by an optional per-step `maxConsumedBytes`; these declarations bind into the approval hash too. A handoff is a non-code data channel between steps, distinct from the code that flows through `dependsOn`.
3. Dry-run `chit_plan_start` with the plan inline (`plan`) or by file (`plan_path`), no `confirm`. It returns the normalized plan, the resolved base commit, the resolved recipe and manifest binding per step that selects one, and an `approvalHash`, and creates nothing.
4. Review the normalized plan, the base, the resolved recipes and manifest bindings, and the `approvalHash`.
5. Confirm by calling `chit_plan_start` again with the SAME plan source (`plan` or `plan_path`) and the same `base_branch` and `max_iterations` you passed to the dry run, plus `confirm: true` and `approval_hash: <the hash from step 3>`. The start re-parses the plan and re-resolves the base, then refuses if the recomputed hash no longer matches, so a plan, base, or budget edited after approval cannot start on a stale hash.

### Reviewing the emitted plan

Before you dry-run the start, read the plan against this rubric:

- Every step is necessary; none is filler or restates another.
- Each `dependsOn` edge is a real code dependency (the step needs the prior step's applied code), and steps with no such need have `[]`.
- `requiredChecks` actually verify that step's work, are chit-executed argv (`command` + `args`), and use the repo's reliable scripts or focused tests rather than a broad raw command that the repo does not use.
- Each step is small enough to review in one sitting.
- Every step `recipe` is an id you actually vetted: it exists in your effective config (`chit.config.json` or the global config) and is the right loop for that step's work. The planner must not have invented one, and no step pairs `recipe` with `manifestPath`.
- No step sets an unexpected `manifestPath`; it should appear only when you named a vetted converge-manifest override. Prefer `recipe` for anything the vetted menu covers.
- No step will start blind to code it needs: if two steps touch the same surface or the later step needs earlier code, the later step has a `dependsOn` edge.
- Every `handoffs`/`consumes` declaration earns its place: a handoff is model output that chit later injects into another model's prompt, so it is an untrusted-data and prompt-injection channel even though it flows through the declared plan. Prefer a committed repo file when the data belongs in the project; reserve handoffs for bounded non-code coordination data. Confirm each declared path is a worktree-relative JSON file, each `maxBytes`/`maxConsumedBytes` cap is tight enough that the data cannot dominate the dependent prompt, and the consuming step's `body` treats the handoff as data to weigh, never as instructions that could override its task, checks, or gates.
- Each consumed handoff comes from a step in the consumer's `dependsOn` closure (no hidden data dependency bypasses the code graph), and each consume alias is unique on its step.
- At the start gate, the base and the budget folded into the `approvalHash` are what you intend before you confirm. For a recipe-backed step, the dry run shows the resolved recipe (id, origin, defaults) and its manifest binding (path, content digest, participants/agents/models); confirm only if that resolved surface is what you mean to run -- a recipe, manifest, or config edited after the dry run changes the hash and the confirm is refused.
