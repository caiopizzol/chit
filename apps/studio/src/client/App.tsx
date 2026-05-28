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

import type { GraphModel, SurfaceKind, ValidationReport } from "@chit/core";
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
import { previewDocument, StudioApiError } from "./api.ts";
import { layoutNodes } from "./elk.ts";
import { adaptGraphModel } from "./graphAdapter.ts";
import { nodeTypes } from "./nodes.tsx";
import type {
	ClientState,
	OpenClientState,
	OpenErrorClientState,
	PickerClientState,
} from "./state.ts";

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

function Inspector({ selected }: { selected: Node | null }) {
	if (!selected) {
		return (
			<section className="inspector">
				<h2>Inspector</h2>
				<p className="empty">Select a node to inspect.</p>
			</section>
		);
	}
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

function OpenMode({ initial }: { initial: OpenClientState }) {
	const [graphModel, setGraphModel] = useState<GraphModel>(initial.graphModel);
	const [surface, setSurface] = useState<SurfaceKind>(
		(graphModel.surface?.kind as SurfaceKind) ?? "claude-skill",
	);
	// Slice 2.0 state. draftSource is the editable JSON; preview round-trips
	// it through the server. dirty/previewError will drive UI signals once
	// real edits land in 2.1.
	const [draftSource] = useState<Record<string, unknown>>(initial.draftSource);
	const [previewPending, setPreviewPending] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);

	const adapted = useMemo(() => adaptGraphModel(graphModel), [graphModel]);
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

	const onSurfaceChange = useCallback(
		async (next: SurfaceKind) => {
			if (next === surface) return;
			setPreviewPending(true);
			setPreviewError(null);
			try {
				const result = await previewDocument(initial.docId, draftSource, next);
				if ("graphModel" in result) {
					setGraphModel(result.graphModel);
					setSurface(next);
				} else {
					setPreviewError(`draft no longer parseable: ${result.document.parseError}`);
				}
			} catch (e) {
				const msg =
					e instanceof StudioApiError ? `${e.status}: ${e.message}` : (e as Error).message;
				setPreviewError(msg);
			} finally {
				setPreviewPending(false);
			}
		},
		[initial.docId, draftSource, surface],
	);

	const selected = nodes.find((n) => n.id === selectedId) ?? null;

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
					<span className="header-divider">·</span>
					<SurfaceSelector value={surface} onChange={onSurfaceChange} disabled={previewPending} />
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
					{previewError && <div className="refetch-error">{previewError}</div>}
					<ValidationPanel validation={graphModel.validation} />
					<Inspector selected={selected} />
				</aside>
			</div>
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
