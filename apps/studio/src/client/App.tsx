// Top-level App. Switches on ClientState.mode and renders the right
// surface: OpenMode (canvas + always-visible right rail with validation
// panel above a read-only JSON inspector), PickerMode, ErrorMode, or
// EmptyMode. Header carries the file label and a surface selector that
// triggers an authenticated POST /api/documents/:docId/preview on
// change; the server runs parseManifest + buildGraphModel against the
// in-memory draftSource and returns a fresh GraphModel. The graph
// adapter derives per-call warn indicators from
// validation.permissions.gaps so node badges and the validation panel
// stay in sync. Nodes are click-to-inspect, not drag-to-arrange:
// selection is sticky, the cursor is pointer, and selected nodes get an
// inverted header strip plus an outer ink outline.

import type { SurfaceKind, ValidationReport } from "@chit/core";
import {
	Background,
	BackgroundVariant,
	Controls,
	type Node,
	ReactFlow,
	useNodesInitialized,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type DiffRow, lineDiff } from "./diff.ts";
import { canonicalize } from "./editor.ts";
import { layoutNodes } from "./elk.ts";
import { adaptGraphModel } from "./graphAdapter.ts";
import type { CallData } from "./nodes.tsx";
import { nodeTypes } from "./nodes.tsx";
import type {
	ClientState,
	OpenClientState,
	OpenErrorClientState,
	PickerClientState,
} from "./state.ts";
import { useDocumentEditor } from "./useDocumentEditor.ts";

const SURFACES: SurfaceKind[] = ["claude-skill", "cli"];

function FitOnReady() {
	const initialized = useNodesInitialized();
	const { fitView } = useReactFlow();
	useEffect(() => {
		if (initialized) {
			fitView({ padding: 0.18, duration: 0 });
		}
	}, [initialized, fitView]);
	return null;
}

type RowState = "ok" | "warn" | "fail";
const ROW_SYMBOL: Record<RowState, string> = { ok: "●", warn: "○", fail: "◆" };

function permissionsRowState(s: "ok" | "needs_override" | "blocked"): RowState {
	if (s === "ok") return "ok";
	if (s === "needs_override") return "warn";
	return "fail";
}

function ValidationPanel({ validation }: { validation: ValidationReport | null }) {
	if (!validation) {
		return (
			<section className="vpanel">
				<h2>Validation</h2>
				<p className="empty">Pick a surface to validate against.</p>
			</section>
		);
	}
	const caps: RowState = validation.capabilities.compatible ? "ok" : "fail";
	const agents: RowState = validation.agents.resolved ? "ok" : "fail";
	const perms: RowState = permissionsRowState(validation.permissions.status);
	const capsDetail = validation.capabilities.compatible
		? "all required present"
		: `missing: ${validation.capabilities.missing.join(", ")}`;
	const agentsDetail = validation.agents.resolved
		? "all resolved"
		: `unknown: ${validation.agents.unknown.map((u) => u.agentId).join(", ")}`;
	const gapCount = validation.permissions.gaps.length;
	const permsDetail =
		gapCount === 0
			? "all enforceable"
			: `${gapCount} gap${gapCount === 1 ? "" : "s"}: ${validation.permissions.gaps
					.map((g) => g.participantId)
					.join(", ")}`;
	return (
		<section className="vpanel">
			<h2>Validation</h2>
			<VRow label="Capabilities" state={caps} detail={capsDetail} />
			<VRow label="Agents" state={agents} detail={agentsDetail} />
			<VRow label="Permissions" state={perms} detail={permsDetail} />
		</section>
	);
}

function VRow({ label, state, detail }: { label: string; state: RowState; detail: string }) {
	return (
		<div className={`vrow vrow--${state}`}>
			<span className="vrow-symbol">{ROW_SYMBOL[state]}</span>
			<span className="vrow-label">{label}</span>
			<span className="vrow-detail">{detail}</span>
		</div>
	);
}

const SESSIONS = ["stateless", "per_topology", "per_scope"];
const FILESYSTEMS = ["read_only", "write"];

// Editable inspector for a selected call node. Values are read from
// draftSource (the in-progress edit), NOT from the node's graphModel data,
// which lags by the debounce. Edits funnel through setParticipantField, the
// same lifecycle as the description edit.
function CallInspector({
	data,
	draftSource,
	onField,
}: {
	data: CallData;
	draftSource: Record<string, unknown>;
	onField: (participantId: string, field: "role" | "session" | "filesystem", value: string) => void;
}) {
	const pid = data.participantId;
	const participants = (draftSource.participants ?? {}) as Record<string, Record<string, unknown>>;
	const p = participants[pid] ?? {};
	const role = String(p.role ?? "");
	const session = String(p.session ?? "stateless");
	const filesystem = String(
		((p.permissions as Record<string, unknown> | undefined)?.filesystem ?? "read_only") as string,
	);
	const agent = String(p.agent ?? data.agent);
	return (
		<section className="inspector">
			<h2>Inspector · call</h2>
			<div className="field">
				<div className="field-label">step</div>
				<div className="field-value">{data.id}</div>
			</div>
			<div className="field">
				<div className="field-label">participant</div>
				<div className="field-value">{pid}</div>
			</div>
			<div className="field">
				<div className="field-label">agent (read-only)</div>
				<div className="field-value">{agent}</div>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-role">
					role
				</label>
				<textarea
					id="call-role"
					className="inspector-input"
					value={role}
					rows={3}
					spellCheck={false}
					onChange={(e) => onField(pid, "role", e.currentTarget.value)}
				/>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-session">
					session
				</label>
				<select
					id="call-session"
					className="inspector-select"
					value={session}
					onChange={(e) => onField(pid, "session", e.currentTarget.value)}
				>
					{SESSIONS.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-filesystem">
					filesystem
				</label>
				<select
					id="call-filesystem"
					className="inspector-select"
					value={filesystem}
					onChange={(e) => onField(pid, "filesystem", e.currentTarget.value)}
				>
					{FILESYSTEMS.map((f) => (
						<option key={f} value={f}>
							{f}
						</option>
					))}
				</select>
			</div>
		</section>
	);
}

function Inspector({
	selected,
	draftSource,
	onParticipantField,
}: {
	selected: Node | null;
	draftSource: Record<string, unknown>;
	onParticipantField: (
		participantId: string,
		field: "role" | "session" | "filesystem",
		value: string,
	) => void;
}) {
	if (!selected) {
		return (
			<section className="inspector">
				<h2>Inspector</h2>
				<p className="empty">Select a node to inspect.</p>
			</section>
		);
	}
	if (selected.type === "call") {
		return (
			<CallInspector
				data={selected.data as CallData}
				draftSource={draftSource}
				onField={onParticipantField}
			/>
		);
	}
	// input / format: read-only field dump (no editable fields in 2.3).
	const fields = Object.entries(selected.data as Record<string, unknown>);
	return (
		<section className="inspector">
			<h2>Inspector · {selected.type}</h2>
			{fields.map(([k, v]) => (
				<div className="field" key={k}>
					<div className="field-label">{k}</div>
					<div className="field-value">{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
				</div>
			))}
		</section>
	);
}

function SurfaceSelector({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (next: SurfaceKind) => void;
	disabled: boolean;
}) {
	return (
		<span className="surface-control">
			surface:&nbsp;
			<select
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.currentTarget.value as SurfaceKind)}
			>
				{SURFACES.map((s) => (
					<option key={s} value={s}>
						{s}
					</option>
				))}
			</select>
		</span>
	);
}

// Editable manifest-level fields. 2.2 ships only `description`; role,
// session, filesystem land in 2.3. Always visible (independent of node
// selection) so editing never requires deselecting a node.
function ManifestPanel({
	description,
	onDescriptionChange,
}: {
	description: string;
	onDescriptionChange: (value: string) => void;
}) {
	return (
		<section className="manifest-panel">
			<h2>Manifest</h2>
			<label className="field-label" htmlFor="manifest-description">
				description
			</label>
			<textarea
				id="manifest-description"
				className="manifest-description"
				value={description}
				onChange={(e) => onDescriptionChange(e.currentTarget.value)}
				rows={3}
				spellCheck={false}
			/>
		</section>
	);
}

function DiffModal({
	relPath,
	before,
	after,
	saving,
	onConfirm,
	onCancel,
}: {
	relPath: string;
	before: string;
	after: string;
	saving: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const rows: DiffRow[] = useMemo(() => lineDiff(before, after), [before, after]);
	// Escape closes the modal. A document-level listener (not an onKeyDown on
	// the overlay div, which never receives focus) is the reliable path.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	const sym = { same: " ", add: "+", del: "-" };
	return (
		<div className="modal-overlay">
			{/* Backdrop is a real button: click-to-dismiss is keyboard-accessible
			    for free, and being a sibling (not an ancestor) of the dialog means
			    no stopPropagation is needed on the dialog itself. */}
			<button type="button" className="modal-backdrop" aria-label="Cancel" onClick={onCancel} />
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={`Review changes to ${relPath}`}
			>
				<h2>
					Write changes to <code className="modal-path">{relPath}</code>?
				</h2>
				<pre className="diff">
					{rows.map((r, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional and the list is static while the modal is open
							key={i}
							className={`diff-row diff-row--${r.type}`}
						>
							<span className="diff-gutter">{sym[r.type]}</span>
							<span className="diff-text">{r.text}</span>
						</div>
					))}
				</pre>
				<div className="modal-actions">
					<button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
						Cancel
					</button>
					<button type="button" className="btn-primary" onClick={onConfirm} disabled={saving}>
						{saving ? "Writing…" : "Write to disk"}
					</button>
				</div>
			</div>
		</div>
	);
}

function ConflictBanner({ onReload }: { onReload: () => void }) {
	return (
		<div className="conflict-banner">
			<span>
				This file changed on disk since it was opened. Save is blocked to avoid clobbering the other
				change.
			</span>
			<button type="button" className="btn-primary" onClick={onReload}>
				Reload from disk
			</button>
		</div>
	);
}

function OpenMode({ initial }: { initial: OpenClientState }) {
	const editor = useDocumentEditor(initial);
	const [diffOpen, setDiffOpen] = useState(false);

	const adapted = useMemo(() => adaptGraphModel(editor.graphModel), [editor.graphModel]);
	const [nodes, setNodes] = useState<Node[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		layoutNodes(adapted.nodes, adapted.edges, adapted.sizes).then(setNodes);
	}, [adapted]);

	const onSelectionChange = useCallback(
		({ nodes: sel }: { nodes: Node[] }) => setSelectedId(sel[0]?.id ?? null),
		[],
	);

	// Explicit click handler because React Flow's click→select handler does
	// not always fire when nodesDraggable=false (the drag+select gesture
	// path is the one that updates the internal selection on click).
	// Keyboard Enter still works through React Flow's a11y handler.
	const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
		setSelectedId(node.id);
	}, []);

	const openDiff = useCallback(() => {
		if (editor.canSave) setDiffOpen(true);
	}, [editor.canSave]);

	// Cmd/Ctrl+S opens the diff modal (the explicit-save-with-review flow),
	// not a direct write. Bound at the document level; re-binds when openDiff
	// changes so it always sees the current canSave gate.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
				e.preventDefault();
				openDiff();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openDiff]);

	const confirmSave = useCallback(async () => {
		const { ok } = await editor.save();
		if (ok) setDiffOpen(false);
		// On conflict/parse-error the modal closes too (the banner / error
		// surfaces the reason in the rail); only a transport error keeps it
		// open implicitly via saving=false + no state change. Close either way
		// to avoid a stuck modal; the rail carries the message.
		else setDiffOpen(false);
	}, [editor]);

	const selected = nodes.find((n) => n.id === selectedId) ?? null;
	const description = String(editor.draftSource.description ?? "");

	// Feed `selected: true` back into the nodes React Flow renders so the
	// .react-flow__node.selected class is applied. Without this, our
	// onSelectionChange only updates inspector state; the DOM never gets the
	// CSS hook for the inverted header + outer outline.
	const reactFlowNodes = useMemo(
		() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })),
		[nodes, selectedId],
	);

	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">{initial.relPath}</span>
					{editor.dirty && (
						<span
							className="dirty-dot"
							role="img"
							title="unsaved changes"
							aria-label="unsaved changes"
						>
							●
						</span>
					)}
					<button
						type="button"
						className="btn-primary save-btn"
						onClick={openDiff}
						disabled={!editor.canSave}
					>
						Save
					</button>
					<span className="header-divider">·</span>
					<SurfaceSelector
						value={editor.surface}
						onChange={editor.changeSurface}
						disabled={editor.previewPending || editor.saving}
					/>
				</span>
			</header>
			<div className="split">
				<div className="canvas-wrap">
					<ReactFlow
						nodes={reactFlowNodes}
						edges={adapted.edges}
						nodeTypes={nodeTypes}
						onSelectionChange={onSelectionChange}
						onNodeClick={onNodeClick}
						proOptions={{ hideAttribution: true }}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable
						minZoom={0.4}
						maxZoom={2}
						// onPaneClick noop keeps selection sticky: clicking blank
						// canvas does not clear the inspector. Users build a mental
						// model around "the inspector reflects what I last looked
						// at"; default-clearing is friction.
						onPaneClick={() => {}}
					>
						<FitOnReady />
						<Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#C7BFAB" />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
				<aside className="right-rail">
					{editor.conflict && <ConflictBanner onReload={() => window.location.reload()} />}
					{editor.previewError && <div className="refetch-error">{editor.previewError}</div>}
					<ValidationPanel validation={editor.graphModel.validation} />
					<ManifestPanel description={description} onDescriptionChange={editor.setDescription} />
					<Inspector
						selected={selected}
						draftSource={editor.draftSource}
						onParticipantField={editor.setParticipantField}
					/>
				</aside>
			</div>
			{diffOpen && (
				<DiffModal
					relPath={initial.relPath}
					before={editor.raw}
					after={canonicalize(editor.draftSource)}
					saving={editor.saving}
					onConfirm={confirmSave}
					onCancel={() => setDiffOpen(false)}
				/>
			)}
		</>
	);
}

function PickerMode({ state }: { state: PickerClientState }) {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">picker</span>
				</span>
			</header>
			<div className="message">
				<h2>Multiple chits in this directory.</h2>
				<p>
					Pick one to open. Click-to-open lands in a later sub-unit; for now, relaunch with an
					explicit path: <code>chit studio &lt;path&gt;</code>.
				</p>
				<ul className="picker-list">
					{state.candidates.map((c) => (
						<li key={c.docId} className={`picker-item picker-item--${c.status}`}>
							<code>{c.relPath}</code>
							<span className="picker-status">{c.status}</span>
						</li>
					))}
				</ul>
			</div>
		</>
	);
}

function ErrorMode({ state }: { state: OpenErrorClientState }) {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">parse error</span>
				</span>
			</header>
			<div className="message">
				<h2>
					Could not parse <code>{state.relPath}</code>.
				</h2>
				<pre className="parse-error">{state.parseError}</pre>
			</div>
		</>
	);
}

function EmptyMode() {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">no chit</span>
				</span>
			</header>
			<div className="message">
				<h2>No chit in this directory.</h2>
				<p>
					Launch with an explicit path: <code>chit studio &lt;path&gt;</code>, or run from a
					directory containing exactly one chit-shaped JSON file.
				</p>
			</div>
		</>
	);
}

export function App({ state }: { state: ClientState }) {
	if (state.mode === "open") return <OpenMode initial={state} />;
	if (state.mode === "open-error") return <ErrorMode state={state} />;
	if (state.mode === "picker") return <PickerMode state={state} />;
	return <EmptyMode />;
}
