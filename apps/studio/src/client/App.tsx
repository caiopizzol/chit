/** @jsxImportSource react */

// Top-level App. Sub-unit 1.2: renders from window.__chit.bootstrap, not
// hardcoded data. Reads the bootstrap, derives ClientState, picks a mode
// component. The OpenMode renders the React Flow canvas + inspector; other
// modes render a small UI for empty/picker/error states.

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
import { layoutNodes } from "./elk.ts";
import { adaptGraphModel } from "./graphAdapter.ts";
import { nodeTypes } from "./nodes.tsx";
import type {
	ClientState,
	OpenClientState,
	OpenErrorClientState,
	PickerClientState,
} from "./state.ts";

// React Flow's fitView prop only fires on initial mount. ELK is async, so
// the initial fit lands on an empty graph and never refits. Wait for
// useNodesInitialized (DOM measured), then call fitView() imperatively.
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

function Inspector({ selected }: { selected: Node | null }) {
	if (!selected) {
		return (
			<aside className="inspector">
				<h2>Inspector</h2>
				<p className="empty">Select a node to inspect.</p>
			</aside>
		);
	}
	const fields = Object.entries(selected.data as Record<string, unknown>);
	return (
		<aside className="inspector">
			<h2>Inspector · {selected.type}</h2>
			{fields.map(([k, v]) => (
				<div className="field" key={k}>
					<div className="field-label">{k}</div>
					<div className="field-value">{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
				</div>
			))}
		</aside>
	);
}

function OpenMode({ state }: { state: OpenClientState }) {
	const adapted = useMemo(() => adaptGraphModel(state.graphModel), [state.graphModel]);
	const [nodes, setNodes] = useState<Node[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		layoutNodes(adapted.nodes, adapted.edges, adapted.sizes).then(setNodes);
	}, [adapted]);

	const onSelectionChange = useCallback(
		({ nodes: sel }: { nodes: Node[] }) => setSelectedId(sel[0]?.id ?? null),
		[],
	);

	const selected = nodes.find((n) => n.id === selectedId) ?? null;

	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="tag">{state.relPath}</span>
			</header>
			<div className="split">
				<div className="canvas-wrap">
					<ReactFlow
						nodes={nodes}
						edges={adapted.edges}
						nodeTypes={nodeTypes}
						onSelectionChange={onSelectionChange}
						proOptions={{ hideAttribution: true }}
						nodesDraggable
						nodesConnectable={false}
						elementsSelectable
						minZoom={0.4}
						maxZoom={2}
					>
						<FitOnReady />
						<Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#C7BFAB" />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
				<Inspector selected={selected} />
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
				<span className="tag">picker</span>
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
				<span className="tag">parse error</span>
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
				<span className="tag">no chit</span>
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
	if (state.mode === "open") return <OpenMode state={state} />;
	if (state.mode === "open-error") return <ErrorMode state={state} />;
	if (state.mode === "picker") return <PickerMode state={state} />;
	return <EmptyMode />;
}
