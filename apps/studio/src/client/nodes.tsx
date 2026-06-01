// Three custom React Flow node types: input, call, format. Hierarchy and
// state markers match the Studio node-state contract.

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";

export type InputData = { name: string; type: string; required: boolean };
export type CallData = {
	id: string;
	// The participant this step calls. Needed by the inspector to edit the
	// participant's role/session/filesystem (a participant can back several
	// call steps; editing here edits the shared participant).
	participantId: string;
	agent: string;
	session: string;
	filesystem: string;
	warn?: { tag: string };
};
export type FormatData = { id: string; refsCount: number; isOutput: boolean };

export function InputNode({ data, selected }: NodeProps<Node<InputData>>) {
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

export function CallNode({ data, selected }: NodeProps<Node<CallData>>) {
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

export function FormatNode({ data, selected }: NodeProps<Node<FormatData>>) {
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
			{/* A format step's output can be referenced by a later step, so it
			    is also a connectable source (uncommon, but the manifest model
			    allows it and referenceToken supports it). */}
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

export const nodeTypes = {
	input: InputNode,
	call: CallNode,
	format: FormatNode,
};
