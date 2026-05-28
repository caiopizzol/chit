// Slice 0 spike. React Flow + ELK rendering the three node sketches against
// the brand's paper-and-ink palette. Three hardcoded nodes (input -> call ->
// format), deterministic ELK layered layout, a tiny right-rail inspector for
// the selected node. No manifest IO, no server, no saving. Throwaway.

import "@xyflow/react/dist/style.css";

import ELK from "elkjs/lib/elk.bundled.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	Background,
	BackgroundVariant,
	Controls,
	Handle,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useNodesInitialized,
	useReactFlow,
} from "@xyflow/react";

type InputData = { name: string; type: string; required: boolean };
type CallData = {
	id: string;
	agent: string;
	session: string;
	filesystem: string;
	warn?: { tag: string };
};
type FormatData = { id: string; refsCount: number; isOutput: boolean };

function InputNode({ data, selected }: NodeProps<Node<InputData>>) {
	return (
		<div className={`chit-node input${selected ? " selected" : ""}`}>
			<header>
				<span>INPUT</span>
			</header>
			<div className="body">
				<div className="id">{data.name}</div>
				<div className="meta">
					{data.type} · {data.required ? "required" : "optional"}
				</div>
			</div>
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

function CallNode({ data, selected }: NodeProps<Node<CallData>>) {
	return (
		<div className={`chit-node call${selected ? " selected" : ""}`}>
			<header>
				<span>CALL</span>
				{data.warn && <span className="right">○ {data.warn.tag}</span>}
			</header>
			<div className="body">
				<div className="id">{data.id}</div>
				<div className="meta">
					{data.agent} · {data.session}
				</div>
				<div className="meta">filesystem: {data.filesystem}</div>
			</div>
			<Handle type="target" position={Position.Left} />
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

function FormatNode({ data, selected }: NodeProps<Node<FormatData>>) {
	return (
		<div className={`chit-node format${selected ? " selected" : ""}`}>
			<header className={data.isOutput ? "is-output" : ""}>
				<span>FORMAT</span>
				{data.isOutput && <span className="right">output</span>}
			</header>
			<div className="body">
				<div className="id">{data.id}</div>
				<div className="meta">refs: {data.refsCount}</div>
			</div>
			<Handle type="target" position={Position.Left} />
		</div>
	);
}

const nodeTypes = {
	input: InputNode,
	call: CallNode,
	format: FormatNode,
};

// Hardcoded shape for the spike: the consult.json story (question -> ask_codex
// -> out). One input, one call, one format. Brand-aligned data only.
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

const baseEdges = [
	{ id: "e1", source: "question", target: "ask_codex" },
	{ id: "e2", source: "ask_codex", target: "out" },
];

// Approximate sizes for the layout pass. Real heights depend on rendered text;
// good enough for the spike since ELK gives us layered positions either way.
const NODE_SIZE: Record<string, { width: number; height: number }> = {
	question: { width: 240, height: 84 },
	ask_codex: { width: 280, height: 116 },
	out: { width: 240, height: 84 },
};

const elk = new ELK();

async function layoutNodes(nodes: Node[]): Promise<Node[]> {
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.spacing.nodeNode": "60",
			"elk.layered.spacing.nodeNodeBetweenLayers": "100",
			"elk.layered.spacing.edgeNodeBetweenLayers": "40",
		},
		children: nodes.map((n) => ({ id: n.id, ...NODE_SIZE[n.id] })),
		edges: baseEdges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	};
	const laid = await elk.layout(graph);
	const positions = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
	return nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } }));
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

// React Flow's fitView prop only fires on initial mount. Our nodes start
// empty and arrive after ELK's async layout, so the initial fit happens
// against an empty graph and never refits. Use useNodesInitialized (DOM
// measured) plus the imperative fitView() to refit once the real nodes are
// in the DOM. Pattern recommended in React Flow v12 docs.
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

function App() {
	const [nodes, setNodes] = useState<Node[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const edges = useMemo(() => baseEdges, []);

	useEffect(() => {
		layoutNodes(baseNodes).then(setNodes);
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
				<span className="tag">Slice 0 · spike</span>
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

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
	<ReactFlowProvider>
		<App />
	</ReactFlowProvider>,
);
