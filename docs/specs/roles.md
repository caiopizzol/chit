# Spec: Reusable Roles + the participant resolver

Status: design, not yet implemented. Internal design note (not the published site).

## Why

A fresh-chat dogfood showed the gap: chit can bind a model (agent) + a persona +
permissions + session into a participant, but that binding is **inline and
per-manifest**. "reviewer" is not a thing you define once; you paste the reviewer
prompt, permissions, session, and agent into every routine. The reusable layer is
missing. This spec adds it, and corrects the resolution architecture so the
reusable layer is honored by execution and validation, not just by display.

## The layer cake (target)

```
adapter  ->  agent profile  ->  role  ->  participant  ->  run policy  ->  run / batch
```

- **Adapter**: how chit talks to a system (`claude-cli`, `codex-exec`, future `openai-api`). Carries the permission-enforcement capability.
- **Agent**: a configured model instance (adapter + model + effort + timeouts + env). "What it is." Config-layer, reusable. EXISTS (`agents.json`).
- **Role**: a reusable job + its governance (default agent + instructions + permissions + session). "What it does." Config-layer, reusable. NEW.
- **Participant**: a role bound into one routine, with allowed overrides. Manifest-local. EXISTS (inline today).
- **Policy / Run / Batch / Audit**: execution shape / one execution / many coordinated / the receipt. EXISTS.

Product language: participants are **not** "sub-agents." A sub-agent is hidden,
same-vendor delegation inside Claude or Codex (host-local). A chit participant is
an independent peer chit conducts across vendors and records. Different layer.

## Verified current architecture (the facts this spec builds on)

Checked against origin/main (`3f49bf3`):

- Core `parseManifest` is browser-safe and **registry/roles-free**: `participant.agent` is just a string (`packages/core/src/manifest/parse.ts:151`); `role` is a required prompt string (`:152`); `session` required; `permissions` defaults `read_only`.
- The agent reference is validated **node-side**, NOT in parse. `findUnknownAgents` / `findEnforcementGaps` (`packages/core/src/shared.ts:27,53`) read `manifest.participants` **directly** (`p.agent`, `p.permissions.filesystem`).
- Those validators are called **independently in six sites**, none routed through `buildGraphModel`:
  `cli/run.ts:497,510` · `cli/converge.ts:584,593,831,846` · `surfaces/claude-skill.ts:149,159` · `surfaces/mcp/engine.ts:82,88` · `runs/run-once.ts:71,80` · `graph-model.ts:220` (the display path).
- Execution reads participants **directly** too: `runtime/execute.ts:13,51` picks the adapter by `participant.agent`, and `:70` injects the persona via `buildAgentInput(participant.role, renderedPrompt)`.
- The persona is part of the **session fingerprint** (`sessions/fingerprint.ts:55` `role: participant.role`) — changing a persona forks a fresh thread, by design.
- `buildGraphModel` (`graph-model.ts:132`) is the **display/audit** seam only: `chit show` renders from it, and `resolveParticipantSnapshots` (`:263`) reuses it for audit. Audit already omits the persona text (records agent/adapter/session/permissions/config).
- Config loads node-side, parses in core: `loadRegistry()` (`apps/cli/src/agents/parse.ts`) reads `~/.config/chit/agents.json` via core `parseRegistry`.

**Conclusion that shapes the design:** resolution cannot live only in
`buildGraphModel`. If it did, `chit show` would look resolved while the six
validation sites and execution operated on unresolved participants. Resolution
needs a central layer every surface consumes.

## The corrected architecture: a distinct resolver

```
parseManifest(raw)                 -> ManifestSpec      (core, browser-safe; participants may be unresolved)
loadConfig()                       -> { agents, roles } (node; one file)
resolveManifest(spec, agents, roles) -> ResolvedManifest (node-side; participants concrete + provenance)
```

Every consumer — `findUnknownAgents`, `findEnforcementGaps`, `buildGraphModel`
(show), `resolveParticipantSnapshots` (audit), `execute` (adapter build +
`buildAgentInput`), converge — consumes **ResolvedManifest**, never the raw spec.
A distinct `ResolvedManifest` type makes "you cannot execute an unresolved
manifest" a compile-time guarantee, which is what structurally prevents the
show-looks-right-but-execution-sees-raw bug.

Types:

- **ParticipantSpec** (manifest-local, from parse): `{ role?: string, agent?: string, instructions?: string, session?: SessionPolicy, permissions?: { filesystem } }`. Either references a role, or inlines the required fields. Parse validates structure only: with no `role` ref, `agent` + `instructions` + `session` are required inline; with a `role` ref, all others are optional overrides. Completeness against the role library is NOT a parse concern (parse stays roles-free / browser-safe).
- **ResolvedParticipant** (from resolveManifest): `{ agent, instructions, session, permissions, provenance: { role?: string, overrides: string[] } }`. All concrete.
- **ManifestSpec** = today's `NormalizedManifest` with participants as ParticipantSpecs. **ResolvedManifest** = the same shape with participants as ResolvedParticipants.

## 1. Vocabulary (lock in docs first, zero code)

agent / role / participant / run / batch / audit, plus the "participants are not
sub-agents" line. This is the highest-leverage step — the confusion that started
this work is a naming collision.

## 2. The gating decision: `role` -> `instructions`

Today `participant.role` IS the persona prompt. The product wants `role` to mean
the reusable concept. Resolve by renaming:

- **`instructions`** = the persona prompt (in a role def, or inline in a participant).
- **`role`** = an optional reference to a named role.

Recommendation: **take the clean break.** 0.x, ~zero adoption, precedent
(`audit_ref`). The alternative (keep `role` as prompt, add a separate
`preset`/`use` reference field) permanently leaves the field `role` meaning
something different from the concept "role" — the exact collision being removed.

Blast radius (verified, not estimated): `parse.ts` (`REQUIRED_PARTICIPANT_KEYS`,
field parse) · `manifest/types.ts` (`NormalizedParticipant.role`) · `execute.ts:70`
(runtime prompt construction) · `sessions/fingerprint.ts:55` (the fingerprint) ·
`graph-model.ts:144` + `show.ts` (display) · Studio editor
(`useDocumentEditor.ts:163`, `App.tsx:153`, `editor.ts`) · examples
(`converge.json`, `consult.json`, `converge-codex-writer.json`) ·
`DEFAULT_CONVERGE_MANIFEST` · docs (`mcp.mdx`, `concepts.mdx`,
`manifest-schema.mdx`, `self-hosting.mdx`) · many test fixtures. This is a
cross-package mechanical rename with a migration note, not a one-file change.

## 3. Config: one file

`~/.config/chit/config.json` with `agents` + `roles` sections (roles reference
agents, so co-edit in one file; avoids cross-file drift). **One read path only:**
`loadConfig` reads `config.json` and nothing else. Do NOT keep `agents.json` as a
second long-lived read path - supporting both reintroduces the exact configuration
ambiguity this change removes. The `agents.json` -> `config.json` move is a
clean break (clean-break policy: 0.x, no back-compat). If migration help is
wanted, it is explicit tooling or a doc note (e.g. "rename `agents.json` to
`config.json` and nest its contents under an `agents` key"), never a fallback read.

```jsonc
{
  "agents": {
    "codex-deep": { "adapter": "codex-exec", "model": "gpt-5-codex", "reasoningEffort": "high" }
  },
  "roles": {
    "implementer": { "agent": "claude", "instructions": "Implement one focused slice…",
                     "permissions": { "filesystem": "write" }, "session": "per_scope" },
    "reviewer":    { "agent": "codex",  "instructions": "Review the diff skeptically…",
                     "permissions": { "filesystem": "read_only" }, "session": "per_scope" }
  }
}
```

A role MUST carry `instructions` and `session`; `permissions` defaults
`read_only`. **`agent` is OPTIONAL** - a role is behavior + governance and may stay
model-agnostic ("reviewer behavior, read-only, per-scope"), leaving the model to a
participant override or a defaulted role. When a role does name an `agent`, it must
resolve in the registry. Core gets a browser-safe `parseConfig` (agents + roles
structure); the node loader reads the file (mirrors `loadRegistry`).

```jsonc
// model-agnostic role (no default agent) — the participant must supply one
"reviewer":         { "instructions": "Review the diff skeptically…",
                      "permissions": { "filesystem": "read_only" }, "session": "per_scope" },
// role WITH a convenient default agent
"default-reviewer": { "agent": "codex", "instructions": "Review the diff skeptically…",
                      "permissions": { "filesystem": "read_only" }, "session": "per_scope" }
```

## 4. Resolution rules (in `resolveManifest`, node-side)

A manifest participant is one of:

```jsonc
"reviewer": { "role": "reviewer" }                        // (a) reference
"reviewer": { "role": "reviewer", "agent": "codex-deep" } // (b) reference + override
"reviewer": { "agent": "codex", "instructions": "…",      // (c) fully inline
              "permissions": {…}, "session": "per_scope" }
```

Resolve, per participant:
1. Start from the referenced role's fields (if `role` present); else empty. The role's `agent` is a DEFAULT and may be absent.
2. Overlay the participant's own fields (shallow). A participant `agent` overrides the role default (and is the only source of an agent when the role is model-agnostic).
3. Result MUST have all of `{agent, instructions, session, permissions}` or it is a resolution error. In particular, a model-agnostic role used by a participant that supplies no `agent` is an error.
4. Resolve the (now concrete) `agent` against the registry (as today).

New failure classes, surfaced at resolution: **unknown role reference**;
**no agent** (neither the role default nor a participant override supplied one);
**incomplete participant** (no role ref and missing an inline required field).

## 5. Override rules: explicit and shallow

An override replaces a **whole top-level field** (`agent`, `instructions`,
`session`, `permissions`). No deep-merge of a partial `permissions` object.
Reading the participant and the role tells you the result without simulating a
merge.

## 6. Validation timing

Role references resolve **before any run starts**, at the same boundary
unknown-agent is caught today. `findUnknownAgents` / `findEnforcementGaps` move to
operate on a ResolvedManifest (so they see concrete agents/permissions), and a
new resolution step runs first; an unresolvable role = run refused, same class as
unknown agent. Core parse stays roles-free: a manifest referencing a role is
structurally valid in core; resolution is the node-side step.

## 7. `chit show` + audit

- **`chit show`** renders the fully **resolved** participant plus provenance:
  `reviewer  (role: reviewer, agent → codex-deep)  read_only  per_scope`. An
  unresolvable role renders like an unknown agent does today (`unresolved`) and
  blocks the run. The displayed graph is always the effective one.
- **Audit** records the resolved snapshot (it already records
  agent/adapter/session/permissions/config) plus cheap provenance
  (`roleRef`, `overrides`). Resolved values are the source of truth — audit must
  never depend on re-reading `config.json` later (it can change).

## 8. Planner-generated batches (later; reuses everything above)

The planner is a **role** (read-only) run under a policy whose output is a
**proposed batch plan**, not a side effect:

1. Operator runs the planner.
2. Planner proposes tasks + role bindings (from the known roles) + dependencies + claimedPaths.
3. chit materializes a batch plan referencing the same roles, and returns it for inspection.
4. Operator approves / edits.
5. chit runs the declared batch (existing batch engine, unchanged).

**Dynamic authoring, static execution.** The graph is still a file you read before
it fires. Roles are the prerequisite: the planner picks from known roles, so its
output is concrete and resolvable, not free-text chaos.

## Anti-scope (the line to hold)

- No dynamic execution: chit never spawns a variable number of agents mid-run because a model decided to. "Spawn agents" = a declared fan-out in the chit (static, inspectable), not model-decided spawning. That is the differentiator vs. agent frameworks.
- No deep override magic.
- No second config concept beyond agent + role.

## Staged implementation (each stage green + shippable)

1. **Vocabulary in this INTERNAL spec** (no code, no public docs). Public docs (the site, README) change WITH the code in later stages or after - never describe roles as shipped before they are.
2. **`role` -> `instructions` rename** (mechanical, cross-package, + migration note). No behavior change.
3. **Core `parseConfig` (agents + roles) + node `loadConfig`.** Roles parsed, not yet referenced.
4. **`resolveManifest` + `ResolvedManifest` type;** participants gain the `role` ref + overrides (ParticipantSpec).
5. **Move every consumer onto ResolvedManifest** (the six validation sites + execute + converge + show + audit). The structural correction.
6. **show/audit provenance.**
7. *(later)* `chit new` / Studio assembly from roles; planner-proposed batches; read-only API adapter for cheap reviewers/advisors.

Stages 1-6 are the complete, correct foundation. Everything dynamic builds on it.
No agent-framework surface, no dynamic execution.

## Decisions (settled)

1. `role` -> `instructions`: **clean break** (no alias). The persona field is renamed everywhere; `role` is then free to mean the reusable concept / reference.
2. **One config file** `~/.config/chit/config.json` with `agents` + `roles`. No parallel `roles.json`.
3. **Distinct `ResolvedManifest` type** (not resolve-in-place). The type boundary makes executing an unresolved manifest a compile-time impossibility.
4. **`role.agent` is optional** (model-agnostic roles allowed); the resolved participant must end up with an agent from the role default or a participant override, else a resolution error.

Process: implement as ONE coherent branch with green checkpoints; do not publish a half-state; first code slice is the `role` -> `instructions` rename, because every later piece depends on that vocabulary being unambiguous.
