import type { ReactNode } from "react";

function VisualShell({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="doc-visual">
			<div className="doc-visual-title">{title}</div>
			{children}
		</div>
	);
}

function Node({ label, detail, tone }: { label: string; detail?: string; tone?: "dark" | "muted" }) {
	return (
		<div className={`doc-visual-node${tone ? ` doc-visual-node-${tone}` : ""}`}>
			<strong>{label}</strong>
			{detail ? <span>{detail}</span> : null}
		</div>
	);
}

function Connector({ label = "->" }: { label?: string }) {
	return <div className="doc-visual-connector">{label}</div>;
}

export function SandboxApplyVisual() {
	return (
		<VisualShell title="Write safety">
			<div className="doc-sandbox">
				<div className="doc-flow">
					<Node label="origin checkout" detail="your working tree" />
					<Connector />
					<Node label="disposable worktree" detail="model writes here" tone="dark" />
					<Connector />
					<Node label="diff" detail="inspect the result" />
				</div>
				<div className="doc-sandbox-outcomes">
					<Node label="dry run" detail="discard the worktree" tone="muted" />
					<Node label="chit apply" detail="write the reviewed diff back" tone="muted" />
				</div>
			</div>
		</VisualShell>
	);
}
