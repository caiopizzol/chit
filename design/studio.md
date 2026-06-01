# chit Studio v0

Spec for the visual editor `chit studio`. Companion to `design/manifest-schema.md` (manifest contract) and `research/backlog.md` (cross-cutting backlog).

Studio is the visual version of the CLI. Same chits, same runtime, same registry. The manifest is the source of truth. The graph is an editing projection of it.

## Product thesis

Today's useful Chit routines come from a manual loop across two or three terminals: one agent proposes, another verifies, the first executes, the user copies context between them. The CLI already captures the routine as a file. Studio should make the routine visible and editable without turning Chit into a different runtime.

The key constraint is that **edges are not first-class in the manifest**. Connections are derived from template references like `{{ steps.diagnose.output }}` and `{{ inputs.question }}`. A visual edge must edit the target template. Dragging a connection inserts a reference into the target prompt or format template. Deleting a connection removes (or offers to remove) the corresponding reference site.

## Architecture

`chit studio` is a CLI subcommand in `apps/cli`. It boots a local server in the invocation cwd, generates a launch token, serves the React app shell with an SSR boot payload, and opens the browser to it.

- **Server.** Hono on Bun, bound to `127.0.0.1`, lifetime tied to the CLI process.
- **Client.** React + React Flow + ELK, bundled via `bun build --target=browser`. Vite as fallback.
- **Source of truth.** The manifest file on disk. The server reads it from disk for the SSR bootstrap (regenerated per `GET /`, so a reload reflects current disk) and on each document API call. Edits go through the server, are validated by `@chit-run/core`'s `parseManifest`, and write canonical JSON back to disk. A per-file content hash is carried through bootstrap/read responses and sent back on save for conflict detection.
- **No layout in the manifest.** Layout is computed deterministically by ELK at render time. Layout persistence, if ever, goes in a sidecar at `.chit/layouts/<id>.json`, not `_layout` in the chit.

The `apps/studio` workspace stays. Internals change from SSR-only Hono to server + client React. The old Hono inspector route deletes at the end of Slice 1 once the React graph renders the same information.

## Discovery

Launch behavior is cwd-scoped and parse-based.

- `chit studio <path>` opens the explicit path, even if it is outside the cwd. The user intentionally passed it. The boot-time path resolver canonicalizes, then refuses only if the file does not exist or is not a regular file. The "browser never names a filesystem path" rule still holds: the server places the resolved path into the docId table and the browser only ever sees the docId.
- `chit studio` (no path) scans the cwd for `*.json`, runs each through `parseManifest`:
	- One success: open it.
	- Multiple successes: picker.
	- Zero successes: empty state with a path input.
- No recursive walking. No `chit.json` filename convention. Cwd scanning is cwd-only.

The server keeps a `docId -> absolutePath` table internally. The browser only sees `docId` and `relPath` (relative to invocation cwd). Absolute paths never cross the wire.

## Block model

The graph has three node types. Participants are not graph nodes by default; they live in a side panel.

- **Input** nodes. Typed inputs declared by the chit (`inputs.question`, `inputs.files`).
- **Call** nodes. Call a participant. Show agent badge, session policy, filesystem permission.
- **Format** nodes. Output formatters. Visually distinct as sinks. The chit's `output` field marks one format node as the canonical output.

Layout defaults to execution levels from `buildGraphModel`'s `executionOrder`. Inputs sit in a left rail (level -1); call/format nodes go in columns for levels 0..N, left to right.

## Edges and references (Slice 3 micro-spec)

An edge is not a first-class manifest object. Edge A → B exists exactly because B's template contains a reference back to A:

- A call step's `prompt` is a template with `{{ inputs.X }}` and `{{ steps.Y.output }}` tokens.
- A format step's `format` is the same kind of template.
- An input node has no template (source only). A call/format node has a template (can be a target; a format can also be a source if a later step references its output).

So "the edge from A to B" lives in **B's template** as a token pointing at A. Creating an edge inserts that token; deleting an edge removes it. There is no separate edge store.

### Prerequisite: editable templates

Ref insertion needs somewhere honest to land, so Slice 3 first makes templates visible and editable in the inspector, on the same `applyDraft` → debounced-preview → save loop as the 2.x fields:

- Call node selected: an editable `prompt` textarea.
- Format node selected: an editable `format` textarea.

Editing a template by hand is the escape hatch for any placement the drag flow does not handle, and it is what makes "reposition the inserted token" just a text edit.

### Create an edge (drag-to-connect)

When the user completes a drag from a source handle to a target handle:

1. **UI-level validity (cheap, advisory):** React Flow's `isValidConnection` rejects the obvious cases before any work — target is not a call/format node (inputs have no template), target === source (a step cannot reference its own output; `parse.ts` forbids it), or the edge already exists. This is feedback only, not the source of truth.
2. **Token:** the reference is determined by the source kind. Input source → `{{ inputs.<name> }}`. Step source (call or format) → `{{ steps.<id>.output }}`.
3. **Insertion (v1: append):** the token is appended to the target template on its own line — `template === "" ? token : template + "\n\n" + token`. Append is deterministic and always produces a valid, readable placement. The user repositions or rewords it afterward in the template textarea; moving a token within a prompt is an ordinary text edit. (A cursor-aware "insert at cursor / replace selection" chooser is explicitly deferred — append + manual reposition is the v1 contract.)
4. **Validate:** Studio builds the candidate draft with the appended token and runs it through `parseManifest` + `buildGraphModel`, exactly like a field edit. The parser is the authority: it rejects unknown refs (ref extraction) and cycles (`topologicalSort`, throws `cyclic dependency among: ...`).
5. **Apply:** on accept, the candidate becomes the in-memory draft (dirty; written only via the explicit save flow). On reject, the drag fails with the parser's message and the draft is unchanged.

### Delete an edge

Deleting edge A → B removes the reference to A from B's template:

1. Scan B's template for tokens matching the source: `{{ steps.A.output }}` for a step source, `{{ inputs.A }}` for an input source.
2. If exactly one occurrence, remove it (and collapse the blank line it leaves). If more than one, show the occurrences with line context and let the user confirm removing all (v1 removes all matching tokens; per-occurrence selection is deferred).
3. Build the candidate draft, validate through `parseManifest`, apply on accept. Removing a reference cannot introduce a cycle or an unknown ref, but it can orphan a step (no longer referenced); that surfaces as a validation warning, not a block.

### Sub-units

- 3.0 — editable `prompt` / `format` templates in the inspector.
- 3.1 — drag-to-connect (append token + validate + apply), with `isValidConnection` advisory checks.
- 3.2 — delete-edge (remove matching tokens + validate + apply).

## Node placement (shipped: no drag-to-arrange)

Node positions are computed by ELK and fixed. Nodes are click-to-inspect, not drag-to-move: `nodesDraggable={false}`, the cursor is a pointer over nodes (grab over the pannable canvas), and selection is sticky (clicking blank canvas does not clear it). This is deliberate for a read/edit inspector whose layout is deterministic and not persisted — transient dragging would imply a persistence that does not exist.

An explicit "Arrange" mode (drag handles via React Flow's `dragHandle`, transient positions, a "Re-layout" button) is deferred until a user actually asks for it. If persistent manual layout is ever needed, it goes in a sidecar at `.chit/layouts/<id>.json`, never `_layout` in the manifest.

## Wire types

All referenced types exist in `@chit-run/core`.

```ts
import type { NormalizedManifest, GraphModel } from "@chit-run/core";

type ParsedStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "parsed";
	manifest: NormalizedManifest;
};

type ErrorStudioDocument = {
	id: string;
	relPath: string;
	raw: string;
	status: "error";
	parseError: string;
};

type StudioDocument = ParsedStudioDocument | ErrorStudioDocument;

type Bootstrap =
	| {
			mode: "open";
			docId: string;
			document: ParsedStudioDocument;
			graphModel: GraphModel;
			hash: string;
	  }
	| {
			mode: "open";
			docId: string;
			document: ErrorStudioDocument;
			hash: string;
	  }
	| {
			mode: "picker";
			candidates: Array<{
				docId: string;
				relPath: string;
				status: "parsed" | "error";
			}>;
	  }
	| {
			mode: "empty";
	  };

type DocumentDetail =
	| { document: ParsedStudioDocument; graphModel: GraphModel; hash: string }
	| { document: ErrorStudioDocument; hash: string };

// Preview + Save wire shapes (Slice 2). The preview path validates a
// draft without writing; the save path validates, writes, and returns
// the new hash. ConflictResponse is sent with HTTP 409 when baseHash
// no longer matches the on-disk hash.

interface PreviewRequest {
	draft: unknown;
	surface?: "claude-skill" | "cli";
}

type PreviewResponse =
	| { document: ParsedStudioDocument; graphModel: GraphModel; canonicalRaw: string }
	| { document: ErrorStudioDocument };

interface SaveRequest {
	draft: unknown;
	surface?: "claude-skill" | "cli";
	baseHash: string;
}

type SaveResponse =
	| {
			document: ParsedStudioDocument;
			graphModel: GraphModel;
			canonicalRaw: string;
			hash: string;
	  }
	| { document: ErrorStudioDocument };

interface ConflictResponse {
	kind: "conflict";
	currentHash: string;
}
```

`hash` is the sha256 hex (64 ASCII chars) of the on-disk bytes the server last read. It flows through bootstrap and `GET`/`PUT` responses; the client carries it through edits and sends it back as `baseHash` on `PUT`. `PreviewResponse` does not carry `hash` because no disk read is involved.

`absolutePath` is intentionally absent from every browser-visible payload. The server holds the absolute path in its `docId -> absolutePath` map; the wire format carries `relPath` for display only.

Picker-mode candidates carry only `status`. Detail (full `StudioDocument` plus `graphModel` for parsed docs) is fetched on demand via `GET /api/documents/:docId`, which returns `DocumentDetail`. The `graphModel` is bundled in the parsed variant so the picker can open a doc and render the graph in one round trip.

## Auth contract

The local server is part of the threat model. Binding to `127.0.0.1` prevents reaching Studio from the LAN but does not defend against DNS rebinding or other localhost-accessible processes. The contract is small but real.

- Token generated at server boot via `node:crypto.randomBytes(32).toString("hex")`. 64 ASCII characters.
- Token never appears in the URL.
- The app shell is SSR'd with a boot payload inlined as `<script>window.__chit = { token, bootstrap }</script>`.
- Client immediately copies the token into `sessionStorage` and clears `window.__chit.token`.
- All API calls send `Authorization: Bearer <token>`.
- Server compares tokens with `node:crypto.timingSafeEqual` after equal-length check.
- Server rejects any `/api/*` request without a valid token.
- Server enforces a Host allowlist: `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. Other Host headers fail with 403 before the token check.
- No cookies. No JWT. No rotation. No `/healthz`.
- Restart: when the server restarts, old tabs hit 401 on their next API call. The client renders "Studio restarted. Refresh to reconnect." No auto-reconnect logic in v0.

Negative requirement:

> Do not add permissive CORS middleware. Studio is a same-origin local app. Browser default same-origin behavior is part of the security model.

## Routes

```
GET  /                                       serves the React app shell with the SSR boot payload
GET  /client/:asset                          token-less; serves index.js / index.css from the built React bundle
GET  /api/documents/:docId                   token required; ?surface=<kind>; returns DocumentDetail (incl. hash)
POST /api/documents/:docId/preview           token required; body PreviewRequest; returns PreviewResponse (no disk write)
PUT  /api/documents/:docId                   token required; body SaveRequest; 200 SaveResponse, 409 ConflictResponse, 404 if unknown/missing, 400 on bad surface or baseHash
GET  /api/loops                              token required; LoopSummary[] read from .chit/loops under cwd, newest-first (read-only)
GET  /api/loops/:loopId                      token required; LoopRecord[] for one loop; 404 unknown, 400 unsafe id, 422 invalid log
GET  /api/installed                          token required; lifecycle.list() -> InstalledSummary[] (501 if no lifecycle)
POST /api/install                            token required; { docId, surface, baseHash, force?, overrideName? }; 200 InstallSummary, 409 ConflictResponse on baseHash drift, 404 unknown docId, 400 bad body, 422 install failure, 501 if no lifecycle
DELETE /api/installed/:name                  token required; lifecycle.uninstall(name); 200 UninstallSummary, 422 failure, 501 if no lifecycle
```

`PUT` semantics: the server reads current disk bytes and hashes them; if the hash differs from `baseHash` it returns `409` with `currentHash` so the client can resolve. Parse failures on the draft return `200` with the error variant (no write). Saves write `canonicalRaw` (tab-indented JSON in key-of-input order); the file on disk is always canonical after a successful save, so subsequent loads hash consistently.

`GET /api/bootstrap` is reserved for a future file-watching re-sync flow. Not in v0. Slice 1 boot data lives in the SSR payload.

## Streaming

Streaming output (run-from-Studio, Slice 6+) uses `fetch` + `ReadableStream`, not `EventSource`. `EventSource` cannot send custom headers, which would force the launch token into the URL. `fetch` keeps `Authorization` in the request header where it belongs.

Decision deferred to the slice that introduces it. Recorded here so the slice does not relitigate it.

## Slice plan

### Slice 0: visual + bundler spike

Three node sketches first (input, call, format) on paper or in Figma. The brand voice needs a target before code starts.

Then a React Flow + ELK + paper-and-ink styling spike with the three custom nodes, one selected-node inspector, deterministic ELK layout. Prove `bun build --target=browser` can bundle React Flow. No manifest IO, no server, no saving.

Output: one screenshot and a yes/no on the Bun bundler.

Fallback if the bundler chokes: Vite. Fallback if the visual fight is worse than expected: structured-form editor with the existing `show` graph as a read-only preview.

### Slice 1: `chit studio [path]`

CLI subcommand. Auto-discovery per the rules above. Local server with the SSR boot payload, launch token, Host allowlist, and `docId` table. React Flow + ELK render from `buildGraphModel`.

Two-pane layout: canvas + right rail. Right rail has the always-visible validation panel above a read-only JSON inspector of the selected node, edge, or input.

Validation panel renders shape-coded indicators per the brand iconography section (`●` `○` `◆` for ok / warn / fail). Rows for capabilities, agents, permissions. The save button is absent in Slice 1 but the disabled-on-`error` rule is designed here so it lands cleanly in Slice 2.

Client state shape is `{ raw, hash, draftSource, graphModel, dirty, previewPending, previewError }`. `raw` is the last server-known file text (boot value in Slice 1; updates after a successful save in Slice 2). `hash` is the sha256 of the on-disk bytes the server last confirmed; the client carries it through edits and sends it back as `baseHash` on `PUT` for conflict detection, and updates it from the save response. `draftSource` is the editable file-shape JSON (`Record<string, unknown>`), NOT the parsed `NormalizedManifest` — NormalizedManifest carries derived fields (`dependencies`, `executionOrder`, declared/inferred requires, step refs) that the user does not edit. `graphModel` is whatever the server last produced for the current `(draftSource, surface)` combination; the client never recomputes it locally because the registry stays server-side. Validation happens via `POST /api/documents/:docId/preview` (read-only validation) and, in Slice 2, `PUT /api/documents/:docId` (validate + write to disk). In Slice 1 `draftSource` is effectively immutable; in Slice 2 it becomes the edit target and each edit triggers a debounced preview.

The old `apps/studio` Hono inspector deletes in sub-unit 1.4 (`src/app.tsx`, `src/index.tsx`, `src/pages/`, `src/app.test.ts`, `src/paths.ts`). The path-resolution logic lives at `apps/studio/src/server/paths.ts` with its own unit tests; the original twelve route tests delete with the routes.

### Slice 2: safe-field editing + explicit save

Editable inspector fields, picked for safety (no ref impact):

- Manifest `description`.
- Participant `role`.
- Participant `session`.
- Participant `permissions.filesystem`.

Block creation through explicit actions (right-rail Add buttons; optionally a contextual canvas affordance):

- Add input, participant, call step, format step. Forms tight to the schema in `packages/core/src/manifest/types.ts`.
- New blocks are created in the in-memory draft, not written to disk.
- Auto-suggested ids the user can edit.
- Connection-driven creation (drag from a handle to empty canvas creates a new block with a pre-inserted ref) is a separate, later slice. Slice 2 ships explicit Add only.

Save behavior:

- Dirty state with a visible indicator. Covers field edits and new blocks.
- Diff preview before write.
- `Cmd+S` / Save button.
- Save is disabled when validation severity is `error`.

Drag-to-connect (ref insertion) stays in Slice 3. Slice 2's new blocks land orphaned; the validation panel surfaces orphans as warnings so users see what is unwired.

`PUT /api/documents/:docId` lands here.

### Slice 3: editable templates + edge create/delete

Per the "Edges and references" micro-spec above. 3.0 makes the call `prompt` and format `format` templates editable in the inspector (same edit loop). 3.1 is drag-to-connect: append the reference token to the target template, then validate the candidate through `parseManifest`. 3.2 is delete-edge: remove the matching token(s), then validate. Every connection or deletion is reified as a candidate draft and accepted only if `parseManifest` accepts; `isValidConnection` is advisory UI feedback, not the authority.

### Slice 4: install / list / uninstall from the UI

Surfaces panel showing installed chits. Install, list, and uninstall actions call the same code paths as the CLI commands. Available only after Slice 2 lands, because install requires a saved manifest on disk.

### Slice 5: registry editor

Visual editor for the user registry file (path subject to the pending v0 state-path migration; see `brand.md` Naming notes). Validates with `parseRegistry`. Saves canonical JSON.

### Slice 6+: run-from-Studio

Still out of scope. The audit log has shipped (runs are recorded and inspectable in Studio after the fact, see `design/audit-log.md`), but live run-from-Studio also wants per-run streaming and cancellation, which are not wired to a Studio-launched run yet. Streaming uses `fetch` + `ReadableStream` per the decision above.

## What this spec does not cover

- The brand-aligned visuals for the three node types. Pinned in the Slice 0 sketches before code starts.
- File-watching and disk-side change detection. Slice 1 reads at boot; future re-sync goes through `GET /api/bootstrap` when it lands.
- Multi-chit projects (a single Studio session editing several chits at once). Slice 1 opens at most one document via the `docId` table.
- YAML support. Tracked separately in `research/backlog.md` under open schema questions.

## Open items

- Encoding of saved files (UTF-8 + LF vs preserving original). Slice 2 decides.
- Validation panel visual treatment beyond "shape-coded indicators per brand iconography." Slice 1 sketches resolve.
- Token regeneration UX after CLI restart. Slice 1 ships "Refresh to reconnect"; revisit if friction emerges.
