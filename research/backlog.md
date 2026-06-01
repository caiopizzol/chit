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

### MCP cancel-controller registration race

`chit_run_step` registered the cancel controller in the `controllers` registry before `runStep` enforced the running-lock, so a concurrent duplicate call on the same run+step overwrote then deleted the live step's controller, leaving `chit_cancel` unable to abort the real in-flight step (the engine lock still prevented a double-spawn, so only cancel was weakened).

What landed:

- `runStep` now takes the `AbortController` and the `StepControllers` registry, derives the signal from the controller, and registers it only after it wins the lock (synchronous, atomic with `status='running'`, before the first await); it unregisters in a `finally` guarded by an ownership check.
- `server.ts` no longer sets/deletes the controller before the lock (and dropped the now-unused `controllerKey` import).
- Regression test `a rejected duplicate runStep does not clobber the in-flight controller`: the duplicate rejects, the owner's controller stays registered, and `cancelStep` still aborts the real step.

### Lifecycle: install marker + `chit list` + safe `chit uninstall`

Operational hygiene for installed skills. The safety boundary is a per-install `.chit-install.json` marker; `chit uninstall` refuses to remove a directory without one, so accidental rm-rf of an unrelated same-named skill is impossible.

What landed:

- `src/surfaces/install-marker.ts` (browser-safe): `InstallMarker` shape, `parseInstallMarker`, `MarkerError`, `INSTALL_MARKER_FILENAME`. Fields: `schema`, `surface`, `installName`, `manifestId`, `runtimePath`, `installedAt`, `manifestHash` (sha256 of persisted manifest.json). Zero node imports; added as a browser-core entry point in `scripts/browser-build-check.sh`.
- `installClaudeSkill` writes `.chit-install.json` as the last step of install, so partial-failure dirs leave no marker and stay invisible to `list`/`uninstall`.
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

### Adapter event streaming

Shipped (`design/audit-log.md`): a per-run audit store under `~/.local/state/chit/audit/runs/<runId>/` with run / step / adapter-call events plus full rendered prompts and outputs as content-addressed blobs and token usage, on all three run surfaces, bounded by retention, readable via `chit audit list` / `chit audit show <runId>` and the Studio audit view. Both adapters now surface their raw event stream through the `onEvent` channel, recorded as `adapter.event` with the raw body blobbed:

- **Codex raw JSONL.** `codex-exec` surfaces every parseable JSONL line, emitted before the failure checks so a run that failed still preserves what it did.
- **Claude stream-json.** `claude-cli` runs `--print --verbose --output-format stream-json --include-partial-messages` and surfaces each JSONL event the same way; the final `result` event preserves the same output/session/usage and failure semantics (`is_error` / non-success subtype / nonzero exit) the single-JSON mode had.

Both adapters surface events LIVE as they arrive: each reads stdout incrementally and records each line with a real arrival timestamp, not buffered until the call completes (a run that fails mid-stream still preserves what it emitted). One honest limit remains: this is the observable CLI event stream (tool events, command executions, reasoning summaries the CLIs emit), never hidden model chain-of-thought.

## Tracked follow-ups

Small cleanups worth doing before the next major slice (Studio).

- **Atomic write + locking for `FileSessionStore`.** Tracked in `design/manifest-schema.md` Concurrency note. Two concurrent CLI runs with the same `--scope` could race and drop a session entry. Acceptable for single-user single-shell; fix before treating sessions as durable infra.
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
- **Trace replay view in HTML inspector.** Lower priority now: the audit log shipped and the Studio audit view covers per-run replay (`design/audit-log.md`). A static-HTML replay would only matter where Studio is not available.

## Studio / Web UI

Spec'd in [design/studio.md](../design/studio.md).

Net direction: `chit studio` is a CLI subcommand that boots a local server in the invocation cwd, serves a React + React Flow + ELK client, and edits the same manifests the CLI runs. The manifest is the source of truth. Edges are derived from template references, so drag-to-connect inserts `{{ inputs.X }}` or `{{ steps.X.output }}` into the target template via `parseManifest`-validated candidate edits. The server is launch-token gated with a Host allowlist; no `?path=` queries from the browser; absolute paths never cross the wire.

Slice 0 is a paper-and-ink visual + bundler spike (three node sketches first, then React Flow styling + `bun build --target=browser`). Slice 1 ships the subcommand with the read-only inspector view. Editing arrives in Slice 2 (safe fields, explicit save, diff preview). Drag-to-connect arrives in Slice 3. Install/registry/run-from-Studio land later in order.

Earlier "Slice A / Slice B" framing in this backlog is superseded by the spec.

## Surface gaps

- **`file[]` inputs via CLI.** The CLI today does not accept `file[]` inputs via `--input` flags. Investigate-bug-style manifests can't be run end-to-end. Decide CLI syntax (probably `--input-files key=path1,path2`) and `can_pass_files` semantics.
- **Multi-string-input support in claude-skill.** Today claude-skill enforces exactly one string input (mapped from `$ARGUMENTS`). Multi-input would need either multiple slash command args or some structured prompt format.
- **MCP tool surface.** Second non-CLI surface to prove platform portability beyond Claude Code. `installMcpTool(manifest)` would emit something an MCP server can register and route. The lifecycle slice has shipped, so management is no longer a blocker; surface-tagging in the marker (`surface: "claude-skill" | "mcp" | ...`) is already in place for the `--surface` filter on `chit list` once a second surface lands.

## Deferred by design (recorded with rationale)

These have explicit answers (we know what we'd do) but don't ship until a real recipe demands them.

- **Loops, dynamic orchestrator, agent-decided handoffs.** `/converge` history (commit `6933109`) is the warning. v1 ships static DAGs only. Adding dynamic handoffs means structured agent output + dispatch, which is the LangGraph cliff.
- **Named artifacts as a separate object model.** Today steps reference each other by id (`{{ steps.X.output }}`). Recipes work without a separate artifact concept; add only when one demands it.
- **Summarization in context transfer.** Requires a model call hidden inside a config field. Defer; add `context.transform: summary` only with explicit cost model.
- **Cost caps, retries, fallbacks.** Require runtime telemetry the platform doesn't have yet.
- **Human-in-the-loop participants.** Adds async/notification machinery (pause execution, wait for input, resume). Out of scope until there's a concrete recipe.
- **Output schemas beyond plain text.** `format` step output is `string`. JSON Schema / typed outputs would expand the manifest contract significantly.

## Open schema questions

From `design/manifest-schema.md` "Deferred details": answers documented inline, but worth tracking here so they don't get lost:

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
- Consider whether `examples/consult.json` still earns `permissions.filesystem: read_only` on the claude participant now that `claude-cli` enforces it via plan mode. It used to be the canonical demo of the unenforced-permission warning; with enforcement in place it installs clean and no longer exercises that path (synthetic fixtures cover the warning instead).
