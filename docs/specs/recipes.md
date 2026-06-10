# Spec: Recipes as a config reference layer (v1)

Status: Phase 1 shipped (config surface only). Internal design note (not the
published site).

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

## Explicit non-goals for this slice

Deferred, not forgotten. None of these exist yet:

- Plan or batch `recipe` fields (nothing executes a recipe).
- Manifest content digest binding in approvals.
- Approval artifact changes of any kind.
- A Studio recipe editor.

When plan-step recipe execution lands, it should resolve the recipe at start,
read the manifest through the normal manifest parser, and bind what was
approved to what runs (digest binding). That is a later phase and its own
spec section.
