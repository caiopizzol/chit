# chit Studio v0

Spec for the visual editor `chit studio`. Companion to `docs/schema-v0.md` (manifest contract) and `docs/backlog.md` (cross-cutting backlog).

Studio is the visual version of the CLI. Same chits, same runtime, same registry. The manifest is the source of truth. The graph is an editing projection of it.

## Product thesis

Today's useful Chit routines come from a manual loop across two or three terminals: one agent proposes, another verifies, the first executes, the user copies context between them. The CLI already captures the routine as a file. Studio should make the routine visible and editable without turning Chit into a different runtime.

The key constraint is that **edges are not first-class in the manifest**. Connections are derived from template references like `{{ steps.diagnose.output }}` and `{{ inputs.question }}`. A visual edge must edit the target template. Dragging a connection inserts a reference into the target prompt or format template. Deleting a connection removes (or offers to remove) the corresponding reference site.

## Architecture

`chit studio` is a CLI subcommand in `apps/cli`. It boots a local server in the invocation cwd, generates a launch token, serves the React app shell with an SSR boot payload, and opens the browser to it.

- **Server.** Hono on Bun, bound to `127.0.0.1`, lifetime tied to the CLI process.
- **Client.** React + React Flow + ELK, bundled via `bun build --target=browser`. Vite as fallback.
- **Source of truth.** The manifest file on disk. The server reads it once at boot and the client renders. Edits go through the server, are validated by `@chit/core`'s `parseManifest`, and write canonical JSON back to disk.
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

## Drag-to-connect

When the user drags from a source handle to a target handle:

1. The candidate connection is interpreted as a template reference:
	- Input → Step: `{{ inputs.X }}`
	- Step → Step: `{{ steps.X.output }}`
	- Step → Format: `{{ steps.X.output }}` inserted into the format template.
2. Studio prompts the user for the insertion site in the target template:
	- At cursor (default if focus is inside the prompt editor).
	- Append as a new section.
	- Replace selected text.
3. The user picks a site. Studio constructs the candidate manifest with the reference inserted at that site.
4. The candidate is parsed through `parseManifest`. The parser rejects unknown refs (ref-extraction in parse.ts) and cycles (parse.ts:343 topological sort, throws `cyclic dependency among: ...`).
5. If `parseManifest` accepts, Studio updates the in-memory draft, marks the document dirty, and re-renders the graph from the candidate. The candidate is written to disk only through the explicit save flow. If `parseManifest` rejects, the drag fails with the parser's error message and no draft mutation occurs.

Site choice is upstream of validation because the choice determines what the candidate manifest actually contains. A reference inserted "at cursor" inside an existing paragraph produces a different template (and therefore a different candidate) than the same reference appended as a new section.

Delete-edge inverts the flow: find all `{{ source.* }}` reference sites in the target template, show the list with line context, let the user choose which to remove.

React Flow's `isValidConnection` is a UI convenience for fast feedback (refuse drags between disconnected components, refuse obvious cycles cheaply). It is not the source of truth. `parseManifest` is.

## Drag-to-arrange

Block positions are transient. Users can drag blocks within a session. Position changes do not mark the manifest dirty. A "Re-layout" button re-applies ELK. Layout persistence is deferred.

If user demand for persistent manual layout materializes, the persistence layer is a sidecar file at `.chit/layouts/<id>.json`, not `_layout` in the manifest.

## Wire types

All referenced types exist in `@chit/core`.

```ts
import type { NormalizedManifest, GraphModel } from "@chit/core";

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
	  }
	| {
			mode: "open";
			docId: string;
			document: ErrorStudioDocument;
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
	| { document: ParsedStudioDocument; graphModel: GraphModel }
	| { document: ErrorStudioDocument };
```

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
GET  /                          serves the React app shell with the SSR boot payload
GET  /api/documents/:docId      token required; returns DocumentDetail
PUT  /api/documents/:docId      token required; validates + writes (Slice 2+)
POST /api/install               token required; { docId, surface } (Slice 4+)
```

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

Client state shape is `{ raw, draft, graphModel }` from day one, even though Slice 1 is read-only. `raw` is the original JSON string (kept for Slice 2's diff preview), `draft` is the parsed `NormalizedManifest`, and `graphModel` is derived from `draft`. In Slice 1 `draft` is immutable; in Slice 2 `draft` becomes the edit target and `graphModel` recomputes on draft changes. Setting up this shape now avoids a state rewrite at Slice 2.

The old `apps/studio` Hono inspector route deletes at the end of this slice. The `paths.ts` resolver moves to the new subcommand under `apps/cli/src/cli/studio/`. About three of the existing twelve route tests survive as unit tests against the moved module; the rest delete with the routes.

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

### Slice 3: drag-to-connect + delete-edge

Insert-reference flow per the drag-to-connect spec above. Multi-site removal on delete. Every connection or deletion is reified as a candidate manifest, parsed through `parseManifest`, and only accepted if the parser accepts.

### Slice 4: install / list / uninstall from the UI

Surfaces panel showing installed chits. Install, list, and uninstall actions call the same code paths as the CLI commands. Available only after Slice 2 lands, because install requires a saved manifest on disk.

### Slice 5: registry editor

Visual editor for the user registry file (path subject to the pending v0 state-path migration; see `brand.md` Naming notes). Validates with `parseRegistry`. Saves canonical JSON.

### Slice 6+: run-from-Studio

Out of scope until audit log, trace, and cancellation ship in the runtime. Streaming uses `fetch` + `ReadableStream` per the decision above.

## What this spec does not cover

- The brand-aligned visuals for the three node types. Pinned in the Slice 0 sketches before code starts.
- File-watching and disk-side change detection. Slice 1 reads at boot; future re-sync goes through `GET /api/bootstrap` when it lands.
- Multi-chit projects (a single Studio session editing several chits at once). Slice 1 opens at most one document via the `docId` table.
- YAML support. Tracked separately in `docs/backlog.md` under open schema questions.

## Open items

- Encoding of saved files (UTF-8 + LF vs preserving original). Slice 2 decides.
- Validation panel visual treatment beyond "shape-coded indicators per brand iconography." Slice 1 sketches resolve.
- Token regeneration UX after CLI restart. Slice 1 ships "Refresh to reconnect"; revisit if friction emerges.
