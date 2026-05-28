/** @jsxImportSource react */

// Top-level App. Sub-unit 1.1: hardcoded graph (mirror of the slice 0 spike)
// rendered with React Flow + ELK against the brand palette. The hardcoded
// data is replaced by window.__chit.bootstrap in sub-unit 1.2.

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
import { type EdgeSpec, layoutNodes } from "./elk.ts";
import type { CallData, FormatData, InputData } from "./nodes.tsx";
import { nodeTypes } from "./nodes.tsx";

// Hardcoded shape: mirrors apps/cli/examples/consult.json's single-advisor
// variant. Replaced by window.__chit.bootstrap.graphModel in sub-unit 1.2.
const baseNodes: Node[] = [
	{
		id: "question",
		type: "input",
		position: { x: 0, y: 0 },
		data: { name: "question", type: "string", required: true } satisfies InputData,
	},
	{
		id: "ask_codex",
		type: "call",
		position: { x: 0, y: 0 },
		data: {
			id: "ask_codex",
			agent: "codex",
			session: "per_scope",
			filesystem: "read_only",
			warn: { tag: "needs check" },
		} satisfies CallData,
	},
	{
		id: "out",
		type: "format",
		position: { x: 0, y: 0 },
		data: { id: "out", refsCount: 1, isOutput: true } satisfies FormatData,
	},
];

const baseEdges: EdgeSpec[] = [
	{ id: "e1", source: "question", target: "ask_codex" },
	{ id: "e2", source: "ask_codex", target: "out" },
];

const NODE_SIZE = {
	question: { width: 240, height: 84 },
	ask_codex: { width: 280, height: 116 },
	out: { width: 240, height: 84 },
};

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

export function App() {
	const [nodes, setNodes] = useState<Node[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const edges = useMemo(() => baseEdges, []);

	useEffect(() => {
		layoutNodes(baseNodes, baseEdges, NODE_SIZE).then(setNodes);
	}, []);

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
				<span className="tag">Slice 1 · 1.1 · hardcoded data</span>
			</header>
			<div className="split">
				<div className="canvas-wrap">
					<ReactFlow
						nodes={nodes}
						edges={edges}
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
