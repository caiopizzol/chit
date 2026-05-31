# Manifest schema

Started as a v0 design doc before the runtime existed; now describes the schema as implemented. Sections marked **Deferred** describe decisions explicitly held back from v1 (with rationale recorded inline). The two manifests in `examples/` are the canonical reference; `src/manifest/parse.ts` is the source of truth for behavior.

## Top-level fields

| Field          | Required | Notes                                                                 |
| -------------- | -------- | --------------------------------------------------------------------- |
| `schema`       | yes      | Integer. Currently `1`.                                               |
| `id`           | yes      | Slug. Used as the install id (`chit run <id>`).                    |
| `description`  | yes      | One sentence. Surfaced in skill/MCP/CLI install artifact.             |
| `inputs`       | yes      | Map of input name to `{ type, optional? }`. Types: `string`, `file[]`. |
| `requires`     | no       | Surface capabilities this manifest needs that the schema cannot infer. Optional; defaults to `{}`. Most capabilities are inferred from manifest shape (see Inferred requirements). |
| `participants` | yes      | Aliases over registry agents with role + session + permissions.       |
| `steps`        | yes      | Map of step id to step body. Step types: `call`, `format`.            |
| `output`       | yes      | Step id whose output is the final return value.                       |

## Participants

Each entry:

- `agent`: id from the agent registry.
- `role`: short text describing the participant's identity or responsibility. The runtime prepends it to every step prompt that targets this participant, using a deterministic envelope (see `call` step below). Adapters that natively support a system or developer channel may map `role` to that transport later; manifest semantics stay "role is applied before task."
- `session`: `stateless` | `per_topology` | `per_scope`. `per_scope` means session persists across runs sharing a scope (e.g., same Claude session + worktree). When any participant uses `per_scope`, the runtime infers `can_provide_stable_scope` as a surface requirement (see Surface capabilities → Inferred requirements).
- `permissions.filesystem`: `read_only` | `write`. Optional. Default is `read_only`. Only declare when the participant needs `write`.

Aliases let the same registry agent participate twice with different roles. Without that, aliases are pure renaming and shouldn't exist.

## Steps

### `call`

```json
{
  "call": "<participant-id>",
  "prompt": "string with {{ template }} references"
}
```

Invokes the participant. Output bound to `steps.<id>.output`.

The runtime constructs the final agent input deterministically:

```
Role:
{participant.role}

Task:
{rendered step prompt}
```

Audit logs and adapter calls always see this shape. Adapters that natively support a separate role/system channel may route the `Role:` portion to that transport instead, but the envelope stays the same so manifests remain transport-agnostic.

### `format`

```json
{
  "format": "string with {{ template }} references"
}
```

Pure string template. No agent call. Output bound to `steps.<id>.output`.

## Templates

Mustache-style references only. No filters, no conditionals, no loops in the template language.

Resolvable references:

- `{{ inputs.<name> }}`: manifest input value.
- `{{ steps.<id>.output }}`: output of a prior step.

If a template references a step that hasn't run yet, the runtime constructs a dependency: step B references step A → B depends on A. Steps with no cross-references run in parallel.

Unresolved references at execution time are a runtime error.

### Rendering by input type

For v1, value substitution is fixed and runtime-owned. Surfaces do not negotiate format.

- `string` inputs: substituted as-is.
- `file[]` inputs: rendered as newline-joined absolute paths. The runtime normalizes relative paths against the invocation cwd/worktree. Paths that do not exist are a runtime error unless the input is declared `optional` and absent. **File contents are not inlined.** Agents with filesystem access read the paths themselves; this keeps token usage predictable and avoids hidden prompt bloat.

Inline content, XML envelopes, JSON arrays, and adapter-specific file rendering are deferred. Add them only when a recipe or adapter forces the question.

## Surface capabilities

Each surface (Claude skill, MCP tool, CLI command) declares what it offers. Examples:

- `can_show_markdown`: surface can render markdown to the user.
- `can_pass_files`: surface can pass file paths through `inputs`.
- `can_read_git_diff`: surface can resolve a "diff" input to actual diff content.
- `can_provide_stable_scope`: surface can supply a stable scope identifier across runs (required for `session: per_scope`).
- `can_prompt_user`: surface can interactively prompt the user mid-run. (Reserved; not used in v1.)

A manifest's `requires` block lists **positive requirements only**: capabilities the manifest needs. Do not list capabilities with value `false` to indicate "not needed"; absence is the convention. Install fails if the surface lacks any required capability.

### Inferred requirements

Several capabilities are implied by the manifest's shape. The author does not declare them; the validator computes them and applies them at install time. This keeps `requires` focused on non-obvious needs and removes a class of "forgot to add the matching capability" bugs.

Current inference rules:

- Any input with `type: file[]` → adds `can_pass_files`.
- Any participant with `session: per_scope` → adds `can_provide_stable_scope`.

`requires` is reserved for capabilities the schema cannot infer (e.g., `can_show_markdown` depends on what the author intends the format step to produce, which the runtime cannot tell from a template string).

Inferred requirements are merged with declared ones before install validation. An author may still declare an inferred capability explicitly; it is treated as a no-op rather than an error.

## Session identity and fingerprinting

A `per_scope` session is keyed by **`(scope, manifestId, participantId, fingerprint)`**. All four components are necessary:

- **scope**: user-supplied via `--scope`, isolates concurrent workspaces.
- **manifestId**: prevents `consult` and `investigate-bug` from sharing sessions even when both use the same agent.
- **participantId**: two participants sharing an agent (e.g. `codex` used twice with different roles) get independent sessions.
- **fingerprint**: model/role/permissions changes invalidate prior sessions.

The fingerprint hashes enough of the `(agent, participant)` pair that a meaningful change starts a fresh session instead of resuming a mismatched one.

Fingerprint inputs (SHA-256, first 16 hex chars):

- Agent registry config: `id`, `adapter` kind, `model`, `reasoningEffort` (effective on both adapters: codex `model_reasoning_effort`, claude `--effort`), and base URL (from `env.ANTHROPIC_BASE_URL` / `env.OPENAI_BASE_URL` / `env.OLLAMA_HOST`). `passModelOnResume` and `strictMcp` are hashed only for claude-cli, where they have runtime effect (on other adapters they hash as null, so toggling one does not fork the session); `strictMcp` is hashed as its effective on/off value, so `undefined` and `true` match.
- Participant `role` text.
- Participant `session` policy.
- Participant `permissions`.

Sensitive env values (API keys, tokens) are deliberately NOT in the fingerprint material.

`strictMcp` defaults to on: a chit-spawned `claude` runs with `--strict-mcp-config` and an empty MCP config, so it loads none of the user's global MCP servers (the session reports `mcp_servers: []`). It isolates MCP servers only: claude's built-in tools still work, and local hooks/skills/plugins still fire (a stream-json probe shows hook events even under strict MCP). This is a safety boundary now that an autonomous loop can let claude edit. Setting `strictMcp: false` on a claude-cli agent is an advanced opt-out for an advisor that genuinely needs MCP; because it changes which servers the spawned claude sees, toggling it forks the session.

`callTimeoutMs` is another operator-facing agents.json field (both adapters): a hard per-call timeout in milliseconds (positive integer; defaults to 15 minutes / `900000`) after which the adapter kills the child agent and fails with a distinct timeout error. Unlike `strictMcp` it is deliberately NOT fingerprint material - it is execution governance, not session identity or context, so changing it does not fork a resumed session.

`noProgressTimeoutMs` is a second operator-facing agents.json field (both adapters): a no-progress watchdog in milliseconds (positive integer) that kills the child when NO stdout arrives for that long, catching a wedged session before the hard `callTimeoutMs` ceiling and failing with a distinct error. It is OFF by default. It measures stdout silence, not reasoning quality: a legitimate call waits on the model API with zero output (a multi-second-plus quiet gap, longer under high reasoning effort), which is indistinguishable from a wedge except by elapsed time. Set it comfortably above the longest quiet gap you expect, and prefer enabling it per agent (e.g. the agents in an unattended `converge` loop) rather than globally. Like `callTimeoutMs` it is execution governance, NOT fingerprint material, so changing it does not fork a resumed session.

On a fingerprint mismatch, the next call sees `session: undefined` (the coordinator can't find a matching entry) and the adapter starts fresh. The old entry remains in the state file but is orphaned — no future call will reference that fingerprint. A periodic cleanup pass could prune stale entries; not yet implemented.

**Deferred**: A visible note in the run output when a fingerprint mismatch is detected. The fresh start is currently silent. Will be added when the runtime gains a way to communicate per-step metadata beyond raw output.

**Concurrency**: `FileSessionStore.save()` is currently read-modify-write without atomic write or inter-process locking. Two concurrent CLI runs with the same `--scope` could race and drop a session entry. Acceptable for single-user single-shell use; needs atomic write + locking before this is treated as durable infrastructure.

## Permission enforcement

`permissions` is a governance contract, not a hint. If a manifest declares `permissions.filesystem: read_only` and the chosen adapter cannot enforce it (e.g., a generic subprocess adapter with no sandbox), install must fail by default.

An install flag (e.g., `--allow-unenforced-permissions`) can opt into installing anyway, but the surface artifact must surface the gap to the executor at run time. "Warning printed once" is not enough for a product whose value proposition is governance.

Adapters declare per-permission enforceability. Examples:

- `codex-exec` adapter: enforces `filesystem: read_only` via `--sandbox read-only`.
- `claude-cli` adapter: does not currently enforce filesystem; depends on Claude's own tool permissions.
- Generic subprocess adapter: cannot enforce; install fails when `read_only` requested unless flag set.

**Status**: enforced at the CLI surface. Each participant's declared `permissions.filesystem` is checked against the chosen adapter's capabilities at install/run time. If the adapter declares `enforces_filesystem_read_only: false` and the participant declares `filesystem: read_only` (the default), the run fails with a locative error unless `--allow-unenforced-permissions` is passed. With the flag, the CLI emits a warning to stderr listing every unenforceable permission before each run.

This means in practice: any manifest using a `claude-cli` participant requires `--allow-unenforced-permissions` (claude-cli does not yet sandbox filesystem access). Codex-only manifests run cleanly because `codex-exec` applies `--sandbox read-only`. When claude-cli is taught to restrict tools (a future adapter change), the gap closes without manifest changes.

## Deferred details

None of these block the parser. Most are settled for v0 with the working answer noted inline. They remain here so a future recipe can reopen the right one.

1. **Template engine.** Custom regex over `{{ x.y.z }}` references, error on unresolved. Mustache is overkill; we use neither sections nor partials.

2. **What each surface uses as scope.** Resolved at the schema level (surfaces declare `can_provide_stable_scope`); still need to pin down what each concrete surface derives scope from. Claude skill: `{claudeSessionId, worktreeHash}`. MCP tool: `{mcpClientId, threadId}` or similar. CLI: `--scope <id>` flag if provided; otherwise refuse to install manifests with inferred `can_provide_stable_scope`. Decide each before that surface ships.

3. **Explicit `output` vs implicit "last step".** Explicit. Verbose but unambiguous. Implicit invites ordering-sensitive recipes.

4. **Parallelism budget.** Unbounded for v0. A recipe with 10 unrelated `call` steps would launch 10 subprocesses at once. Reasonable for 2-3 advisors; problematic at scale. Add an implicit `max_parallel` only when a recipe hits the wall.

5. **`inputs` types beyond `string` and `file[]`.** Add `boolean`, `number`, `enum` only when a recipe needs them.

6. **Error semantics.** Fail-fast: if any `call` step fails, no downstream step runs, including `format` steps. The runtime returns a structured failure envelope (which step failed, error message, partial outputs collected before the failure). The surface decides how to render the envelope. Per-step `on_failure: continue` can come later.

7. **YAML vs JSON.** JSON for v0: parses everywhere, no dependency. YAML is friendlier for hand-authoring multi-line prompts. Revisit if hand-authoring becomes the dominant path.

8. **Agent registry location and format.** Probably `~/.config/handoff/agents.json`. Ships with built-in `codex` and `claude` entries; user config merges on top.

## Verifying the schema against the examples

Run through both `examples/*.json` and check:

- Does every field have a clear runtime meaning?
- Is any field present only because it "felt necessary" without a recipe demanding it?
- Is any recipe behavior expressible only by stretching a field's meaning?

If answers are "yes, no, no", the schema is ready for implementation. If any answer flips, edit the schema before writing code.
