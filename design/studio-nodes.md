# Studio node sketches

Targets for the three React Flow node types Studio renders: input, call, format. They exist so the Slice 0 spike has a concrete brand-aligned target before code starts. Without them, the spike risks producing React Flow's default visual vocabulary, which reads as "workflow SaaS" and contradicts the brand.

Goal: specify hierarchy, labels, badges, and states. Not art direction. Pixel sizes, exact spacing, font weights, and border thickness are decided in the spike. What appears on each node, in what order, with what state markers, is decided here.

Companion to `design/studio.md` (the Slice 0..6 plan) and `brand.md` (paper-and-ink palette, shape-coded status, JetBrains Mono for code-like labels).

## Shared rules

- Status uses shape, not color, per `brand.md` Iconography. Pass: `●`. Warn: `○`. Fail: `◆`.
- The status indicator, when present, sits top-right of the node header alongside a short tag (e.g., `○ needs check`).
- The node-type label (`INPUT`, `CALL`, `FORMAT`) sits top-left of the header in mono uppercase. It is part of what the user reads at a glance to know what kind of block this is.
- The identifier (input name, step ID) is the largest text in the node and the second thing read.
- Secondary metadata lives on one line below the identifier, dot-separated, in lowercase. Examples: `string · required`, `codex · per_scope`, `refs: 2`.
- A tertiary line below the secondary line is reserved for governance-relevant detail when applicable. Example: `filesystem: read_only`. Omitted when not relevant.
- Handles for graph connections are on the left (input) and right (output) edges of the node body, vertically centered. Their styling is deferred to the spike.

## Input node

```
┌──────────────────────┐
│ INPUT                │
│ question             │
│ string · required    │
└──────────────────────┘
```

Fields, top to bottom:

1. `INPUT` type label, top-left.
2. Input name (matches `inputs.<name>` in the manifest).
3. `<type> · <required|optional>`. Examples: `string · required`, `file[] · optional`.

States the input node can show:

- Default (no indicator): input is declared and referenced by at least one step.
- `○` warn `unreferenced`: input is declared but no step's template references it. Useful to surface, not blocking.

Handles: output only (right edge). Inputs have no incoming edges.

## Call node

```
┌────────────────────────────┐
│ CALL        ○ needs check  │
│ ask_codex                  │
│ codex · per_scope          │
│ filesystem: read_only      │
└────────────────────────────┘
```

Fields, top to bottom:

1. `CALL` type label, top-left. Status indicator + short tag, top-right.
2. Step ID (the key under `steps.<id>` in the manifest).
3. `<agent_id> · <session_policy>`. Examples: `codex · per_scope`, `claude · stateless`.
4. `filesystem: <read_only|write>`. Omitted if the participant declares no filesystem permission.

States the call node can show:

- Default: agent resolved, capabilities met, permissions enforceable by the adapter.
- `○` warn `needs check`: the participant declares `filesystem: read_only` but the adapter cannot enforce it. Maps to `permissions.status === "needs_override"` in `ValidationReport`.
- `◆` fail `unknown agent`: agent id is not in the registry. Maps to `agents.resolved === false`.
- `◆` fail `missing capability`: surface is missing a capability the manifest requires. Maps to `capabilities.compatible === false`.

The short tag next to the indicator (`needs check`, `unknown agent`, `missing capability`) is the user's first hint at what is wrong. Full detail lives in the right-rail validation panel, not in the node.

Handles: input (left edge), output (right edge).

## Format node

```
┌──────────────────────┐
│ FORMAT        output │
│ out                  │
│ refs: 2              │
└──────────────────────┘
```

Fields, top to bottom:

1. `FORMAT` type label, top-left. The word `output` (not an icon) top-right when this format step is the chit's canonical output, per the manifest's `output` field. Omitted otherwise.
2. Step ID.
3. `refs: <count>`. The number of template references the format string pulls in.

States the format node can show:

- Default: refs valid.
- `output` marker: this is the chit's canonical output. Exactly one format node per chit carries this marker.

Format nodes that are not the canonical output render with the same shape and fields, minus the `output` marker. They exist when the manifest has multiple format steps and only one is canonical.

Handles: input (left edge). An output handle appears only if the format step is referenced by a later step (uncommon but allowed).

## Edges

Edges are not node-like. They are thin lines between handles, computed from template references at render time, not stored anywhere. The spike should not give them their own visual chrome: no labels, no glyphs, no arrowhead decoration beyond what React Flow's default edge provides.

Edge stroke is Ink (`#0A0A0A`) per `brand.md` Colors. No accent. Edge thickness is decided in the spike.

## What this doc deliberately leaves open

- Exact pixel dimensions of each node.
- Padding, line height, font sizes.
- Whether the node-type label uses small caps, tracking, or some other typographic treatment.
- Hover, selected, dragging visual states (decided in the spike against React Flow's API).
- Whether the short tag next to a status indicator is one phrase per condition or a fixed vocabulary (decided in the spike based on legibility).
- Selected-edge visual state (decided in the spike).
