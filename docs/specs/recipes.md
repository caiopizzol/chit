# Spec: Recipes as a config reference layer (v1)

Status: Phases 1-5 shipped: config surface, manifest digest binding in
approvals, plan-step `recipe`, batch `recipe`, and Studio read-only recipe
visibility. Internal design note (not the published site).

## What shipped

A `recipes` top-level section in the layered config, next to `agents` and
`roles`. A recipe is a named, vetted REFERENCE to an execution manifest plus
safe runtime defaults:

```json
{
	"recipes": {
		"deep-review": {
			"mode": "converge",
			"manifestPath": "manifests/review.json",
			"maxIterations": 5,
			"callTimeoutMs": 600000,
			"description": "The review loop we trust."
		}
	}
}
```

Fields, v1:

- `mode` - required; only `"converge"` is accepted. Any other value fails at
  parse so a future mode is an explicit addition, never a silent passthrough.
- `manifestPath` - required, non-empty string. The manifest the recipe names.
- `maxIterations`, `callTimeoutMs` - optional, positive integers.
- `description` - optional string.

Anything else is an unknown field and fails loudly. That is deliberate: a
recipe must NOT redeclare participants, prompts, checks, reviewer wiring, or
approval policy. Those live in the manifest it points at. Recipes are
references, not a second execution language.

## Layering and provenance

Recipes layer exactly like agents and roles: built-ins (none today), then
global (`~/.config/chit/config.json`), then repo (`chit.config.json` at the
repo root). A later layer replaces a recipe by id, whole; no field merging.
`ConfigProvenance` gained a `recipes` record, and `NormalizedConfig` exposes
`recipes` next to `roles`. `chit doctor` shows a `recipes` row (only when at
least one is defined) with each recipe's origin layer.

Recipe ids are kebab-case, same regex as agent and role ids.

## Trust boundary

The repo config is untrusted project input, so two rules apply to repo
recipes:

1. **No approval surface at all.** v1 recipes have no approval or policy
   field, so there is nothing for a repo to relax; the unknown-field rejection
   enforces this in every layer.
2. **`manifestPath` containment.** A repo recipe's `manifestPath` must be
   repo-relative: absolute paths (POSIX and Windows forms) and any `..`
   segment are rejected with a hard error. The check is lexical and lives in
   the browser-safe parser (`rejectEscapingRepoManifestPath` in
   `packages/core/src/config/parse.ts`): a relative path with no `..` segments
   cannot escape whatever repo root it is later resolved against, so no
   filesystem or repo-root context is needed. Global recipes are operator
   input and may use absolute paths.

The repo config stays at the repo root (`chit.config.json`), visible and
diffable, not under `.chit/`.

## Plan-step `recipe` (Phase 3)

A sequential plan step may select a recipe by id (`"recipe": "deep-review"`).
The rules, all enforced:

- `recipe` and `manifestPath` are mutually exclusive on a step; the parser
  rejects the pair. Direct `manifestPath` stays available for manual expert
  use, but the plan-author prompt and the human review rubric steer planners
  to the closed recipe menu.
- The `chit_plan_start` dry run resolves every step's recipe from the effective
  config for the launch checkout, then binds the resolved values: the recipe's
  identity (id, provenance, mode, default budgets) lands in the approval
  artifact's per-step `recipes` record, and the recipe's manifest binding
  (path, source, content digest, participant execution summary) lands in the
  same per-step `manifests` record direct-manifest steps use. Repo-relative
  manifest content is read from the approved git tree, not the dirty working
  tree. Both records are in the approval hash, so a redefined recipe, an edited
  manifest, or a config change that re-routes participants forces re-approval.
- At each later step launch, the existing digest + participant re-verification
  applies unchanged (the step pauses `needs_human` on drift), because the
  recipe's resolved binding sits in the same record the verifier reads.
- A step-level `maxIterations`/`callTimeoutMs` (hash-bound through the plan)
  overrides the approved recipe defaults; absent, the recipe defaults flow
  into the launched converge job.

## Batch `recipe` (Phase 4)

Batches can select recipes at either the batch level or the task level.

Rules:

- A batch-level `recipe` and batch-level `manifest_path` are mutually exclusive.
- A task-level `recipe` and task-level `manifestPath` are mutually exclusive.
- Per-task selection wins over the batch default.
- Effective precedence is: task `recipe` / `manifestPath`, then batch `recipe` /
  `manifest_path`, then the bundled default converge manifest.
- Every selected recipe resolves through the same manifest binding record used
  for direct manifest references: manifest path, manifest source, content
  digest, and participant execution summary.
- The batch approval hash binds the task graph, base commit, launch knobs,
  resolved recipe receipts, and manifest bindings. A changed recipe, manifest,
  or participant config refuses the confirmed start.
- Worker launch re-verifies manifest digest and participant summary before each
  task runs. Drift pauses the task for a human decision instead of silently
  launching.

Batch dependencies are still launch gates only. They do not merge code between
tasks, with or without recipes.

## Studio recipe visibility (Phase 5)

Studio exposes recipes read-only in two places:

- The effective config drawer lists recipes by origin, id, mode, manifest path,
  optional budgets, and description.
- The selected live run detail can show the approved recipe and bound manifest
  as execution topology blocks before the agent blocks.

Studio does not edit recipes yet. It also does not expose manifest contents,
participant instructions, environment values, prompt bodies, model output, or
audit blobs in the live tower.

## Explicit non-goals for the shipped recipe arc

Deferred, not forgotten. None of these exist yet:

- Recipe editing of any kind.
- Any approval-gate relaxation or auto-approval.
- General structured handoffs between plan steps. Recipes select the loop to
  run; they do not define dataflow between steps.
