# Orchestration architecture plan

Status: internal architecture plan. Not a published site page.

This note describes the path from today's Chit to a real orchestrator experience:
the user defines trusted agents, roles, manifests, and recipes; a planning agent
can propose which recipe to run; Chit previews the exact execution; the operator
approves; Chit runs, verifies, records, and visualizes the loop.

The goal is not to compete with Claude Code, Codex, or any agent host. The goal is
to be the thin runtime underneath them: the place where multi-agent routines are
declared, inspected, executed, verified, and remembered.

## Product stance

Chit should stay a declared runtime, not a dynamic router.

The useful pattern from modern agent loops is real: stop driving each prompt by
hand, design the loop that prompts agents for you. Chit already owns the durable
part of that pattern:

- declared participants and permissions
- cross-vendor agent execution
- isolated worktrees
- implement and review convergence
- Chit-executed required checks as an oracle outside the model
- plan and batch starts gated by approval hashes
- receipts, traces, audit references, and Studio live visibility

The missing layer is a small, explicit object that lets an operator say:

> For this class of work, use this planner, this execution manifest, these
> budgets, these checks, and these approval gates.

That object is a **recipe**.

## Vocabulary to hold

- **Adapter**: how Chit talks to a system, such as `claude-cli` or `codex-exec`.
- **Agent**: a configured model instance: adapter, model, effort, timeouts, and
  global-only trust-boundary fields.
- **Role**: reusable behavior and governance: instructions, permissions, session
  policy, and optionally a default agent.
- **Participant**: a role or inline participant bound into one manifest.
- **Manifest**: the executable graph. It owns participants, prompts, required
  checks, and routing.
- **Recipe**: a named, vetted reference to an execution manifest and safe runtime
  defaults. It does not redeclare the manifest's graph.
- **Plan**: a reviewed sequence of steps. Each step may select a recipe.
- **Run receipt**: what actually ran: recipe, manifest, agents, models, checks,
  elapsed time, verdicts, artifacts, and audit references.

Use **recipe**, not profile. "Profile" already collides with agent model
profiles, and an earlier config profile surface was removed when planning scoped
down. This is recipes v1, informed by that removal.

## Core principles

1. **Reference, do not duplicate.**
   A recipe points at a manifest. It does not carry its own implementer,
   reviewer, co-reviewer, or check vocabulary. The manifest remains the one
   source of truth for execution wiring.

2. **Closed menu, not synthesized power.**
   A planner may choose a recipe id from a visible vetted menu. It may not invent
   manifest paths, agents, adapters, permissions, env, or MCP isolation settings.

3. **Universal gates stay universal.**
   Recipes must never weaken `chit_plan_start`, `chit_batch_start`, apply, or
   cleanup approval gates. Repo config cannot turn an approval into auto-run.
   If a future relaxation exists, it must be global-only and explicitly trusted.

4. **What was reviewed is what runs.**
   Approval cannot bind only a path. It must bind the resolved recipe, resolved
   manifest content digest, relevant runtime defaults, resolved base commit, and
   resolved participant execution summary. A moved base, edited manifest, edited
   recipe, or changed agent/model selection must force re-approval.

5. **Verification stays outside the model.**
   Reviewer verdicts are useful. Chit-executed checks, browser verification,
   production errors, and other external signals are the ground truth.

6. **Studio observes and explains first.**
   Studio should show which recipes, agents, models, and phases are active. It
   should not become the launch and apply surface until the underlying contracts
   are settled.

7. **Receipts beat transcripts by default.**
   Live Studio views stay concise: phase, agent, model, timing, recent event
   skeleton, and checks. Full prompts and outputs remain in audit surfaces and
   should be opt-in.

## Current architecture facts

These are the local facts this plan builds on:

- Config already has agents and roles, layered from built-ins to global config to
  repo `chit.config.json`.
- Repo config is visible at the repo root and is intentionally not under `.chit/`.
- Repo config already rejects trust-boundary agent fields such as `env` and
  `strictMcp`.
- Built-in agent ids are stable anchors and cannot be redefined.
- Later config layers replace user-defined agents and roles as whole entities,
  with provenance.
- Plans and batches already use dry-run by default and require `confirm:true`
  plus a matching approval hash to start.
- Plan steps currently carry optional `manifestPath`, `maxIterations`, and
  `callTimeoutMs`.
- The current approval artifacts bind `manifestPath` as a string, not manifest
  file content.
- Worker launch paths read manifest files later. That makes content digest
  binding necessary before recipes become a primary surface.
- Worker launch paths also load config fresh. That is the right lifecycle
  behavior, but it means a long plan must compare the current resolved
  participant summary against the approved one before each step launches.
- Converge currently has one verdict-gating reviewer. Multi-review can be
  advisory via a manifest today, but verdict-level co-review is engine work.

## Recipe shape

Recipes live in config next to agents and roles:

```jsonc
{
  "recipes": {
    "deep-feature": {
      "mode": "converge",
      "manifestPath": "examples/converge-required-checks.json",
      "maxIterations": 3,
      "callTimeoutMs": 1200000
    }
  }
}
```

V1 fields:

- `mode`: `"converge"` for one recipe-backed converge run.
- `manifestPath`: the vetted manifest this recipe runs.
- `maxIterations`: optional default budget.
- `callTimeoutMs`: optional default adapter-call timeout.
- `description`: optional short operator-facing explanation.

Rules:

- A recipe does not contain participants, checks, prompts, or review semantics.
  Those belong in the manifest.
- A repo recipe's `manifestPath` must be repo-relative, stay inside the repo, and
  reject traversal. Global recipes may reference absolute paths because the
  global config is operator-owned.
- A repo recipe cannot define approval relaxation, env, strict MCP behavior, or
  any trust-boundary knob.
- Recipes layer like agents and roles: built-ins if any, then global, then repo.
  Later user layers replace whole recipe entities, with provenance.
- A recipe id must be stable, kebab-case, and suitable for display in receipts.

## Recipe resolution

Recipe resolution should happen at the same boundary as plan and batch dry-runs:
before anything mutates.

For each selected recipe, resolve:

- recipe id and provenance
- mode
- manifest path as the operator-facing identity
- manifest absolute path for local reading
- manifest content digest
- parsed and resolved manifest summary, including required-check policy
- participant execution summary: participant id, role ref if any, agent id,
  adapter, model, reasoning effort, session, permissions, env key names, and
  config provenance
- runtime defaults: max iterations and call timeout

Do not include env values in returned views or approval payloads. If env values
can materially affect execution, that remains a global operator trust boundary,
not a repo-authored recipe feature.

## Approval binding

The current path-only binding is not enough for any manifest reference. The
approval artifact for a plan or batch should bind the effective execution for
both recipe-resolved manifests and direct expert `manifestPath` use:

```jsonc
{
  "strategy": "plan",
  "base": { "ref": "main", "sha": "..." },
  "plan": { "...": "normalized plan" },
  "resolvedRecipes": {
    "deep-feature": {
      "mode": "converge",
      "manifestPath": "examples/converge-required-checks.json",
      "manifestDigest": "sha256:...",
      "participants": {
        "implement": {
          "agentId": "claude",
          "adapter": "claude-cli",
          "model": "..."
        },
        "review": {
          "agentId": "codex",
          "adapter": "codex-exec",
          "model": "..."
        }
      },
      "maxIterations": 3,
      "callTimeoutMs": 1200000
    }
  }
}
```

The exact shape can be smaller, but the invariant cannot be weaker.

Required behavior:

- Dry-run resolves every recipe, every manifest reference, and every manifest
  content digest, then returns the approval hash.
- Confirm re-resolves everything and refuses if the hash changed.
- Each later step launch re-verifies the manifest digest and the resolved
  participant execution summary before spawning the worker. Confirm-time
  verification alone is not enough for long multi-step plans.
- If launch-time config or manifest drift changes the participant summary or
  manifest digest, the step pauses as `needs_human` before running. Do not pin
  the whole config for the plan lifetime; keep fresh config per launch and make
  drift visible.
- Receipts stamp the recipe id, recipe provenance, manifest path, manifest
  digest, and resolved participant summary.

This keeps the guarantee intact even when a plan step launches hours after the
operator approved the plan.

### Manifest digest read point

Digest from the same content source the step is meant to execute, not from a
convenient dirty checkout.

- For repo-relative manifest paths, the approved digest is computed from the git
  tree at the approved base commit, not from the caller checkout's working tree.
  At step launch, re-read the manifest from the git tree the step worktree was
  cut from and compare it to the approved digest. If an earlier plan step changed
  the manifest, that is execution-contract drift and the later step pauses for a
  new human decision.
- Repo-relative manifest resolution must also reject symlink escapes before any
  filesystem-backed read: either read the git blob directly and reject symlink
  objects, or `realpath` the resolved worktree path and verify it stays under the
  repo root.
- For absolute or global manifest paths, the approved digest is computed from the
  filesystem file at dry-run and re-verified from the same path before launch.

This makes the read point explicit and avoids comparing a caller's uncommitted
file to a worker's checked-out file.

## Plan integration

Add `recipe` to plan steps:

```jsonc
{
  "id": "api",
  "title": "Add the API route",
  "body": "Implement the route...",
  "dependsOn": [],
  "recipe": "deep-feature",
  "commitMessage": "feat(api): add route"
}
```

Rules:

- `recipe` and `manifestPath` are mutually exclusive in planner-authored plans.
- Direct `manifestPath` remains available for manual expert use, but planner
  prompts should prefer `recipe`.
- If a step names a recipe, the recipe supplies the manifest and default runtime
  knobs.
- Step-level budgets may override recipe defaults only if the current plan
  schema already permits them and the resolved values are hash-bound.
- The plan dry-run should show the resolved recipe for every step before approval.

Planner prompt update:

- Show the planner the vetted recipe menu.
- Instruct it to choose a recipe by id or omit for default.
- Forbid raw `manifestPath` unless the operator explicitly names a vetted path.
- Keep the existing plan rubric: dependency edges are code dependencies, checks
  must verify the step, commit messages are reviewed, no invented fields.

## Batch integration

Batch recipes should follow plan recipes, not lead them.

Reason: batch dependencies are launch gates only. They do not merge code between
tasks. Recipe support in batch is useful for independent parallel work, but it
does not solve sequential orchestration.

When added:

- `chit_batch_start` tasks may name `recipe`.
- `recipe` and `manifestPath` are mutually exclusive.
- The batch approval artifact binds every task's resolved recipe and manifest
  digest.
- The worker verifies each task's manifest digest before launch.

## Co-review

There are two levels.

### Advisory co-review

This can be done now with a manifest pattern:

- one or more read-only reviewers inspect the same context
- an aggregator step summarizes disagreements
- a human or downstream step reads the advisory output

This is useful, but it does not gate convergence. It is not the same as a
verdict-level reviewer.

### Verdict-level co-review

This is engine work and should not be smuggled in as a manifest example.

Open design questions:

- Does any blocking reviewer block the loop?
- Does unanimous proceed converge?
- Can one reviewer request revise while another proceeds?
- Which reviewer output becomes `prior_review`?
- How are required checks sequenced relative to multiple reviewers?
- How does Studio show multiple reviewers without becoming noisy?

Recommendation: defer verdict-level co-review until recipes and recipe-backed
plans are working. Then implement it as an explicit converge policy extension,
not a hidden convention.

## Studio direction

Studio should make orchestration understandable without becoming a wall of text.

Near-term read-only surfaces:

- effective config drawer already exists for agents and roles
- add recipes to that drawer: id, mode, manifest path, origin, budgets
- selected run detail shows recipe id and resolved agent/model blocks
- recipe graph view shows orchestrator, implementer, reviewer, and Chit checks

Do not build a recipe editor first. First make resolution visible.

Before adding a graph authoring surface, decide what happens to the old unmounted
editor and React Flow machinery:

- delete it if Studio is no longer a manifest editor
- repurpose it for recipe and manifest visualization if it still fits

Avoid carrying two graph stacks.

## Orchestrator experience

The orchestrator should be a configured read-only planning role, not a privileged
hidden controller.

Safe v1 flow:

1. Operator states a goal.
2. Orchestrator runs through Chit using a planner manifest.
3. Orchestrator emits a native sequential plan that selects recipes from the
   vetted menu.
4. Operator reviews the plan, recipe resolution, base commit, budgets, checks,
   and approval hash.
5. Chit starts the approved plan.
6. Each step converges through implementer, reviewer, and Chit checks.
7. Operator applies each step into the integration branch.
8. Chit records receipts and shows the run in Studio.

This is an orchestrator experience without model-decided runtime mutation.

Later, the orchestrator can recommend recipes automatically. It still should not
approve its own plan or weaken the gates.

## Meta-loops

Meta-loops are the later layer: loops that inspect receipts, cost, failures, and
external signals to recommend which recipes are worth running.

Do not build this before recipes. Without recipes, a meta-loop has no stable
unit to recommend.

Possible future examples:

- inspect failed CI and recommend `fix-failing-check`
- inspect recurring review findings and recommend a stricter reviewer recipe
- inspect long-running receipts and recommend timeout or model changes
- inspect production errors and propose a plan for human approval

The first version should recommend. It should not launch.

## Implementation sequence

### Phase 1: recipe config foundation

- Add `recipes` to config parsing and types.
- Keep whole-entity replacement and provenance.
- Reject repo recipe trust-boundary fields.
- Require repo recipe paths to be repo-relative and contained in the repo.
- Add `chit doctor` or config view output for effective recipes.
- Add tests for layering, provenance, path containment, and forbidden fields.

### Phase 2: recipe resolution and digest binding

- Implement recipe resolution for a given cwd.
- Resolve manifest content and compute a digest.
- Reject repo-relative manifest symlink escapes before any filesystem-backed read
  by reading git blobs directly or realpath-verifying the resolved path stays
  under the repo root.
- Resolve manifest participants against current config and produce a safe
  participant execution summary.
- Extend plan and batch approval artifacts to bind resolved recipes, direct
  manifest references, manifest digests, and participant execution summaries.
- Re-verify manifest digests and participant summaries at each worker launch,
  pausing as `needs_human` on drift.
- Stamp recipe id, manifest digest, and participant summary in receipts.

This phase closes the path-only approval hole.

### Phase 3: plan step `recipe`

- Add `recipe` to `PlanStep`.
- Reject `recipe` plus `manifestPath` together.
- Resolve recipe defaults into the plan launch view.
- Update `plan-author` to choose from recipes.
- Update the human review rubric to include recipe checks.
- Dogfood with a real plan that uses a recipe.

### Phase 4: batch task `recipe`

- Add `recipe` to batch tasks.
- Apply the same approval binding and launch-time digest verification.
- Keep docs explicit that batch dependencies do not merge code.

### Phase 5: Studio read-only recipe visibility

- Add recipes to the config drawer.
- Add recipe id and resolved agent/model blocks to selected run detail.
- Add compact recipe graph rendering for the selected run or recipe.
- Keep launch/apply out of Studio.

### Phase 6: recipe authoring

- Add Studio editing only after the read-only model proves useful.
- Save to visible config files.
- Validate before write.
- Use content-hash conflict detection.
- Never expose env values.
- Never allow repo-authored approval relaxation.

### Phase 7: co-review and meta-loop experiments

- Try advisory multi-review manifests first.
- Design verdict-level co-review only if advisory review is insufficient.
- Build meta-loop recommendations only after receipts and recipes give them a
  stable unit to reason about.

## Definition of done for the architecture

Chit has the orchestrator experience when:

- a repo or user can define agents, roles, and recipes
- a planner can select recipes from a closed menu
- every launch preview shows the exact recipe, manifest digest, agents, models,
  permissions, checks, base, budgets, and approval hash
- any change to the plan, base, recipe, manifest content, or resolved
  agent/model identity forces re-approval before start or a `needs_human` pause
  before a later step launches
- a run receipt answers which recipe ran, which models executed, what Chit
  checked, what changed, and what remains for the operator
- Studio can show several active sessions with concise agent blocks, timing,
  recent activity, recipe identity, and checks
- full transcripts remain opt-in audit evidence, not the default live surface

## Anti-scope

Do not build:

- a hosted scheduler
- SaaS connectors as a core requirement
- model-decided dynamic routing
- planner-synthesized permissions, adapters, model configs, or manifest paths
- repo-config approval relaxation
- a second execution vocabulary inside recipes
- transcript streaming as the default Studio experience
- verdict-level co-review without explicit convergence semantics

## Architectural bets

The important bet is that Chit becomes powerful by staying boring at the runtime
boundary.

Agents can be smart. The orchestrator model can be strong. The loop can be long.
But the runtime contract should stay inspectable:

- declared artifacts
- closed menus
- digest-bound approvals
- external checks
- receipts
- concise live state

That is how Chit gives Claude Code, Codex, and future agents more leverage
without becoming another opaque agent framework.
