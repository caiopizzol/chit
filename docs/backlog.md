# Backlog

Engineering backlog for chit. Ordered by the next thing to do, then by category.

## Status

```
Manifest schema           ✓ parser-ready, 8 deferred items decided
Runtime + trace           ✓ (intentionally narrow; no warnings inside)
Agent registry            ✓ built-ins + user config + adapter capabilities
Adapters                  ✓ Codex + Claude, with session resume, live-verified
Coordinator + state       ✓ scope + manifestId + participantId + fingerprint
CLI surface               ✓ run, install, show
Claude-skill surface      ✓ install + live-verified end-to-end
Inspector (chit show)  ✓ ascii / json / mermaid / html
Safety                    ✓ shell-injection blocked, path-traversal blocked, governance gated
Browser-core boundary     ✓ src/agents/registry.ts split out; check:browser passes
Invocation warnings       ✓ collectInvocationWarnings helper; CLI emits from data
Lifecycle (list/uninstall)✓ install marker + list + safe uninstall

263 tests · 681 expect()
typecheck, biome, and check:browser all clean
```

## Recently completed

### Lifecycle: install marker + `chit list` + safe `chit uninstall`

Operational hygiene for installed skills. The safety boundary is a per-install `.handoff-install.json` marker; `chit uninstall` refuses to remove a directory without one, so accidental rm-rf of an unrelated same-named skill is impossible.

What landed:

- `src/surfaces/install-marker.ts` (browser-safe): `InstallMarker` shape, `parseInstallMarker`, `MarkerError`, `INSTALL_MARKER_FILENAME`. Fields: `schema`, `surface`, `installName`, `manifestId`, `runtimePath`, `installedAt`, `manifestHash` (sha256 of persisted manifest.json). Zero node imports; added as a browser-core entry point in `scripts/browser-build-check.sh`.
- `installClaudeSkill` writes `.handoff-install.json` as the last step of install, so partial-failure dirs leave no marker and stay invisible to `list`/`uninstall`.
- `src/surfaces/lifecycle.ts` (node-only): `listInstalled(parentDir)` walks the parent looking for markers - silently skips dirs without one (foreign skills) and dirs with malformed/wrong-shape markers (no crash). `uninstall(parentDir, name)` refuses with a `LifecycleError` unless the target dir has a valid marker.
- Shared kebab-case name validator (`VALID_INSTALL_NAME_RE`, `isValidInstallName`) lives in browser-safe `install-marker.ts` and is enforced by both install and uninstall. Without it, `chit uninstall ../sibling-install` against parent A could rm-rf a legitimately-marked install in parent B (the traversed path satisfies the marker check). Empirically reproduced before adding the guard.
- `chit list [--to <dir>] [--json]` - text table by default, structured JSON with `--json`.
- `chit uninstall <name> [--to <dir>]` - rejects path-traversal names up front, then refuses cleanly with the marker error if no marker; reports `was at: <path>` on success.
- 22 new unit tests for marker parsing + lifecycle semantics (including the path-traversal regression test) + 10 CLI subprocess tests covering install → list → uninstall round-trip, foreign-skill protection, sibling-install protection via name validation, and the no-name / no-install refusals.

### Invocation warning side-channel

Extracted governance warning generation into a shared, browser-safe helper. CLI surface user-visible behavior is identical (same stderr message); the producer is now structured data that any surface can render.

What landed:

- `Warning` type and `collectInvocationWarnings(manifest, registry, options)` in `src/surfaces/shared.ts` (browser-safe; the Studio can import it without pulling node).
- CLI's `runRun` now produces warnings via the helper and emits to stderr from the data, not by computing inline. Same wire, cleaner producer.
- `RunResult` shape unchanged. `executeManifest` and `wrapAdaptersWithSessions` untouched. Runtime stays narrow.
- 3 new tests directly verifying the helper: empty without the opt-in, one warning per gap with the opt-in, no warnings when all adapters enforce.

Future kinds plug into the same `Warning` type discriminator (`kind`). PR for `fingerprint_mismatch` will follow once the store gains `list(scope, manifestId, participantId)` for detection.

### Browser-core unbundling (registry split + `check:browser`)

Split `src/agents/parse.ts` into pure metadata + file-backed loader so the Studio (and any future browser-side consumer) can import schema, graph-model, validators, and registry helpers without transitively pulling `node:fs`/`node:os`/`node:path`.

What landed:

- New file `src/agents/registry.ts` with `RegistryError`, `parseRegistry`, `getAdapterDescriptor`, `isBuiltInAgent`, built-in agents, adapter capability descriptors. Zero node imports.
- `src/agents/parse.ts` reduced to `loadRegistry` + `defaultConfigPath` (the `node:fs`/`node:os`/`node:path` parts). Re-exports `RegistryError` for backward compat with catchers.
- `src/surfaces/graph-model.ts` and `src/surfaces/shared.ts` import `getAdapterDescriptor` from `../agents/registry.ts`. No transitive node pull.
- Test imports updated across four test files.
- `scripts/browser-build-check.sh` (run via `bun run check:browser`) bundles the seven browser-core entry points and greps for forbidden Node tokens (`node:`, `readFileSync`, `existsSync`, `writeFileSync`, `mkdirSync`, `rmSync`, `createHash`, `randomBytes`, `homedir`, `process.cwd`, `process.env`). Passes today; new browser-core entry points get added to the script as the surface grows.

## Up next

### Audit log + trace replay

Bigger lift: extend trace data and add a per-run audit store.

- Extend `TraceEvent` with `step.adapter.requested` / `step.adapter.completed` carrying the rendered prompt and the adapter output.
- Add a per-run audit log under `~/.local/state/handoff/runs/<runId>.json`.
- `chit show <run-id>` or similar inspector for replaying a past run.
- Unlocks the v2 inspector replay view in the visual UI.

## Tracked follow-ups

Small cleanups worth doing before the next major slice (Studio).

- **Real `claude-cli` sandboxing.** Pass `--allowedTools` or similar so `claude-cli` actually enforces filesystem read-only. Flips `enforces_filesystem_read_only` to `true` and removes the WARNING for default consult/ask-claude usage. Closes the documented governance gap.
- **Atomic write + locking for `FileSessionStore`.** Tracked in `docs/schema-v0.md` Concurrency note. Two concurrent CLI runs with the same `--scope` could race and drop a session entry. Acceptable for single-user single-shell; fix before treating sessions as durable infra.
- **Fingerprint mismatch visible note.** Two pieces, both needed:
  1. *Detection.* `FileSessionStore.load(key)` currently returns `undefined` on any miss, conflating "no prior session for this participant" with "different fingerprint exists for same participant." Add `list(scope, manifestId, participantId): SessionKey[]` so the coordinator can detect a real mismatch (some fingerprint exists but doesn't match this run's).
  2. *Surfacing.* Once detection works, emit an `InvocationWarning` (kind: `"fingerprint_mismatch"`) via the invocation warning layer (already exists).
  The surfacing layer alone is not enough; the detection piece in the store is the real work.
- **Capability name validation in `requires`.** Today an author can typo `can_show_markdonw` and validation passes until install. Add a known-capability set check at parse time.
- **CLI install command emits warnings about residual unenforced permissions.** Currently `installClaudeSkill` returns `enforcementGaps`; the CLI prints a count. Surface them as structured `InvocationWarning`s instead, sharing the runtime side-channel.

## UI / inspector enhancements (within `chit show`)

Improvements to the existing static-output inspector. Separate from the Studio web app below.

- **Interactive edge inspector in HTML output.** The graph model already carries `nodes[].refs` and `nodes[].promptTemplate`. Currently the HTML just lists refs as text. Click-to-expand panel with the prompt template and source step output type would help debugging.
- **Validation styling in Mermaid.** Nodes with permission gaps or missing capabilities should be styled red. Mermaid supports `classDef`.
- **`chit show` rendering for multi-input manifests.** Today `show` works fine but the `claude-skill` install surface only supports one input. When the install surface gains multi-input support, `show`'s inspection should mark which inputs flow to which step.
- **Trace replay view in HTML inspector.** v2 after the audit-log slice ships.

## Studio / Web UI

The static HTML from `chit show --format html` proves visualization. The Studio is the dynamic version: load a manifest, render the graph, edit configs through structured forms, export a canonical manifest. Built on the same browser-safe core the CLI uses so the surfaces don't drift.

### Prerequisite — DONE (Browser-core unbundling)

The browser-core boundary now exists. See "Browser-core unbundling" under "Recently completed" for what landed. The Studio can import from these modules without pulling node:

- `src/manifest/parse.ts` — parseManifest, types
- `src/agents/registry.ts` — parseRegistry, getAdapterDescriptor, isBuiltInAgent, RegistryError
- `src/surfaces/graph-model.ts` — buildGraphModel, validationSeverity
- `src/surfaces/shared.ts` — findEnforcementGaps, findMissingCapabilities, findUnknownAgents
- `src/surfaces/show.ts` — renderShow (for HTML/Mermaid/ASCII parity with `chit show`)

What the Studio gets from a server (Slice B) but NOT from core:

```
loadRegistry, installSurface, runManifest, listInstalled, uninstallSurface
```

Runtime-only modules (deliberately kept node-side, do not bundle for browser):

- `src/sessions/*` — uses `node:crypto` and `node:fs`. Browser doesn't need fingerprint computation or session persistence at design time.
- `src/surfaces/claude-skill.ts` — uses `node:crypto` (random delimiter) and `node:fs`. Install is a server concern.
- `src/adapters/*`, `src/runtime/*`, `src/cli/*` — execution surfaces, not design-time surfaces.

`scripts/browser-build-check.sh` enforces this boundary (run via `bun run check:browser`). Add new entry points to the script as the browser-core surface grows.

Browser-safe API (`@chit/core`):

```
parseManifestSource(source, "yaml" | "json")
buildGraphModel(manifest, registry, surfaceKind?)
validateManifest(manifest, registry, surfaceKind?)
serializeManifest(draft, "yaml" | "json")
```

Node-only API (`@chit/runtime` / current `src/`):

```
loadRegistry()
runManifest(...)
installSurface(...)
listInstalled(...)
uninstallSurface(...)
```

### Slice A — Static editor SPA (no server)

Drag-drop or paste a manifest, render the graph, edit through structured forms, export new canonical manifest. No `loadRegistry`, no `runManifest`, no install.

- **Render**: same `buildGraphModel` the CLI uses; level-column layout from `chit show --format html`.
- **Inspector**: structured forms for participants, steps, inputs, requires.
- **Validation overlay**: red for capability/agent gaps, yellow for permission needs override (matching `validationSeverity`).
- **Surface selector**: claude-skill | cli, with capabilities + applicable notes visible.
- **Export**: canonical JSON. YAML iff the platform commits to YAML (separate decision, tracked below).
- **Editing direction**: forms → graph → export. v1 does NOT support live text editing with round-trip — YAML comment preservation is real work, defer to v2.
- **Distribution**: single HTML file, or `chit studio --static` opens browser to a local file. No server, no port, no auth.

Slice A's value: proves the editor concept against real users without committing to the server/lifecycle/auth stack. Ships in weeks. Forces the `@chit/core` prerequisite, which improves the CLI's imports as a side effect.

### Slice B — Studio server (registry + run + install from the UI)

Only after Slice A is in real users' hands and we know what's actually load-bearing.

- Local Bun/Node server exposing node-only APIs.
- Lifecycle decision: one process per session (server exits when browser disconnects) vs. always-on.
- Auth decision: trust localhost vs. require token. CORS / origin policy.
- Registry editor: add/edit `~/.config/handoff/agents.json` entries.
- Install/uninstall flow: drives the existing install path; surface chooser + name override + collision handling.
- Run-from-UI: cost visibility, streaming output, cancellation, concurrency control. Own product, large.

### Product question to answer before deep UI investment

**Are manifests authored often, or written once and run many times?**

- If "once": the inspector is the product. `chit show` is 80% of the value; Slice A is polish.
- If "often": the editor is the product. Slice A is the wedge; Slice B is the platform.

Today's answer is "once" — the recipes (consult, investigate, etc.) are stable. If chit grows into a place where teams encode their own internal handoffs, "often" wins.

### YAML as primary format — explicit decision needed

The platform is JSON-only today. The Studio proposal mentions YAML. Introducing YAML in the UI is a platform-wide decision (parser deps, conventions, examples, install behavior). Not a UI choice.

Two paths:
- **JSON-only**: Studio renders/edits JSON, matching everything else. Simplest. Tooling already works.
- **YAML primary**: commit to YAML across the platform; update `examples/`, parser, schema doc. Real change.

Defer until Slice A planning forces the choice.

### Avoid in v1

- Drag-to-anywhere canvas (creates invalid manifests fast; structured forms + validation are safer)
- Browser-side schema reimplementation (drift; use `@chit/core`)
- Browser-side IO or agent execution (security; let the server handle it)
- Bidirectional YAML/form live editing (comment-preservation cost; pick a direction in v1)
- Run-from-UI before cost telemetry exists in the runtime

## Surface gaps

- **`file[]` inputs via CLI.** The CLI today does not accept `file[]` inputs via `--input` flags. Investigate-bug-style manifests can't be run end-to-end. Decide CLI syntax (probably `--input-files key=path1,path2`) and `can_pass_files` semantics.
- **Multi-string-input support in claude-skill.** Today claude-skill enforces exactly one string input (mapped from `$ARGUMENTS`). Multi-input would need either multiple slash command args or some structured prompt format.
- **MCP tool surface.** Second non-CLI surface to prove platform portability beyond Claude Code. `installMcpTool(manifest)` would emit something an MCP server can register and route. The lifecycle slice has shipped, so management is no longer a blocker; surface-tagging in the marker (`surface: "claude-skill" | "mcp" | ...`) is already in place for the `--surface` filter on `chit list` once a second surface lands.

## Deferred by design (recorded with rationale)

These have explicit answers — we know what we'd do — but don't ship until a real recipe demands them.

- **Loops, dynamic orchestrator, agent-decided handoffs.** `/converge` history (commit `6933109`) is the warning. v1 ships static DAGs only. Adding dynamic handoffs means structured agent output + dispatch, which is the LangGraph cliff.
- **Named artifacts as a separate object model.** Today steps reference each other by id (`{{ steps.X.output }}`). Recipes work without a separate artifact concept; add only when one demands it.
- **Summarization in context transfer.** Requires a model call hidden inside a config field. Defer; add `context.transform: summary` only with explicit cost model.
- **Cost caps, retries, fallbacks.** Require runtime telemetry the platform doesn't have yet.
- **Human-in-the-loop participants.** Adds async/notification machinery (pause execution, wait for input, resume). Out of scope until there's a concrete recipe.
- **Output schemas beyond plain text.** `format` step output is `string`. JSON Schema / typed outputs would expand the manifest contract significantly.
- **Drag-to-anywhere canvas editing.** Free-form node placement with arbitrary connections creates invalid manifests faster than the validator can catch them. Studio Slice A uses structured forms + live validation instead; canvas-style remains deferred until there's evidence forms aren't expressive enough.

## Open schema questions

From `docs/schema-v0.md` "Deferred details" — answers documented inline, but worth tracking here so they don't get lost:

- Template engine choice (custom regex over `{{ x.y.z }}` for v0; defer Mustache)
- Per-surface scope derivation (claude-skill: session+worktree; CLI: --scope; MCP: TBD)
- Implicit `max_parallel` (unbounded for now; add when a recipe hits the wall)
- `inputs` types beyond `string` and `file[]` (`boolean`, `number`, `enum` when needed)
- YAML vs JSON for manifests (JSON for v0; revisit if hand-authoring dominates)
- Agent registry shape evolution

## Smoke verifications still TBD

Live-vendor verifications we said we'd do but haven't run yet:

- **`ask-claude.json`** live skill smoke (only `consult.json` was verified end-to-end through the Claude skill surface).
- **`consult-stateless.json`** live skill smoke (parallel fan-out without session resumption).
- **Fingerprint mismatch behavior** with a real session: change a participant's role between runs and verify a new vendor session is established instead of resuming a mismatched one.

## House-keeping

- Decide what `chit` becomes as a real distributable (npm package? compiled binary? bun-installable script?). Today users run via `bun apps/cli/src/cli/run.ts`. Affects the `runtimePath` auto-detection in `chit install`.
- README hasn't been updated since the initial commit; current state is roughly right but missing the install/show commands and the surface story.
- Consider whether `examples/consult.json` should drop `permissions.filesystem: read_only` from the claude participant once `claude-cli` actually sandboxes. Today it's the canonical demo of the unenforced-permission warning; if claude-cli enforces, the example becomes silent on governance.
