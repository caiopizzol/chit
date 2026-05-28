// Adapter from @chit/core's GraphModel to React Flow inputs (nodes, edges,
// and a size map for the ELK layout pass). The adapter is pure and small:
// it does not know about consult.json or any specific chit. Given any
// GraphModel produced by buildGraphModel, it yields the right React Flow
// nodes typed for the three custom node components.
//
// Per-call `warn` indicators derive from `model.validation?.permissions.gaps`
// directly. The adapter takes only the GraphModel because GraphModel already
// carries both the surface and the validation; passing validation as a
// separate argument would create drift potential.

import type { GraphModel } from "@chit/core";
import type { Node } from "@xyflow/react";
import type { CallData, FormatData, InputData } from "./nodes.tsx";

export interface AdaptedGraph {
	nodes: Node[];
	edges: Array<{ id: string; source: string; target: string }>;
	sizes: Record<string, { width: number; height: number }>;
}

// Default sizes ELK uses as layout hints. Real heights depend on rendered
// text; ELK still produces correct layered positions either way.
const DEFAULT_SIZE = {
	input: { width: 240, height: 84 },
	call: { width: 280, height: 116 },
	format: { width: 240, height: 84 },
};

export function adaptGraphModel(model: GraphModel): AdaptedGraph {
	const nodes: Node[] = [];
	const sizes: Record<string, { width: number; height: number }> = {};

	// Participants with an enforcement gap under the selected surface. Any
	// call node whose participant is in this set gets a warn indicator.
	const gappedParticipants = new Set<string>();
	if (model.validation) {
		for (const gap of model.validation.permissions.gaps) {
			gappedParticipants.add(gap.participantId);
		}
	}

	for (const gnode of model.nodes) {
		sizes[gnode.id] = DEFAULT_SIZE[gnode.kind];

		if (gnode.kind === "input") {
			const inputDef = model.inputs[gnode.inputName];
			if (!inputDef) {
				throw new Error(`graphAdapter: input "${gnode.inputName}" not in model.inputs`);
			}
			const data: InputData = {
				name: gnode.inputName,
				type: inputDef.type,
				required: !inputDef.optional,
			};
			nodes.push({ id: gnode.id, type: "input", position: { x: 0, y: 0 }, data });
			continue;
		}

		if (gnode.kind === "call") {
			const participant = model.participants[gnode.participantId];
			if (!participant) {
				throw new Error(
					`graphAdapter: participant "${gnode.participantId}" not in model.participants`,
				);
			}
			const data: CallData = {
				id: gnode.id,
				agent: participant.agentId,
				session: participant.session,
				filesystem: participant.permissions.filesystem,
			};
			if (gappedParticipants.has(gnode.participantId)) {
				data.warn = { tag: "needs check" };
			}
			nodes.push({ id: gnode.id, type: "call", position: { x: 0, y: 0 }, data });
			continue;
		}

		// kind === "format"
		const data: FormatData = {
			id: gnode.id,
			refsCount: gnode.refs.length,
			isOutput: gnode.isOutput,
		};
		nodes.push({ id: gnode.id, type: "format", position: { x: 0, y: 0 }, data });
	}

	const edges = model.edges.map((e) => ({
		id: `${e.from}->${e.to}`,
		source: e.from,
		target: e.to,
	}));

	return { nodes, edges, sizes };
}
