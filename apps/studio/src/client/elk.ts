// ELK adapter for React Flow node layout. Returns React Flow nodes with
// positions filled in from a layered left-to-right run.

import type { Node } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();

export interface EdgeSpec {
	id: string;
	source: string;
	target: string;
}

export interface SizeMap {
	[id: string]: { width: number; height: number };
}

export async function layoutNodes(
	nodes: Node[],
	edges: EdgeSpec[],
	sizes: SizeMap,
): Promise<Node[]> {
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.spacing.nodeNode": "60",
			"elk.layered.spacing.nodeNodeBetweenLayers": "100",
			"elk.layered.spacing.edgeNodeBetweenLayers": "40",
		},
		children: nodes.map((n) => ({
			id: n.id,
			width: sizes[n.id]?.width ?? 240,
			height: sizes[n.id]?.height ?? 90,
		})),
		edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	};
	const laid = await elk.layout(graph);
	const positions = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
	return nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } }));
}
