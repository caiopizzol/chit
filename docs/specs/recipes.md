# Spec: Recipes as a config reference layer (v1)

Status: Phase 1 (config surface), Phase 2 (manifest digest binding in
approvals), and Phase 3 (plan-step `recipe`) shipped. Internal design note
(not the published site).

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

## Explicit non-goals for this slice

Deferred, not forgotten. None of these exist yet:

- Batch task `recipe` fields (Phase 4).
- A Studio recipe UI (read-only visibility or editing).
- Recipe editing of any kind.
- Any approval-gate relaxation or auto-approval.
