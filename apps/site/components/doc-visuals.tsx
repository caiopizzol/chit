import type { ReactNode } from "react";

function VisualShell({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="doc-visual">
			<div className="doc-visual-title">{title}</div>
			{children}
		</div>
	);
}

function Node({
	label,
	detail,
	tone,
}: {
	label: string;
	detail?: string;
	tone?: "dark" | "muted";
}) {
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

export function RoutinePipelineVisual() {
	return (
		<VisualShell title="One routine, several behaviors">
			<div className="doc-flow">
				<Node label="config" detail="profiles, routines, steps" />
				<Connector />
				<Node label="normalize" detail="one internal routine shape" />
				<Connector />
				<Node label="routine" detail="one declared workflow" tone="dark" />
				<Connector />
				<Node label="runtime" detail="text, flow, loop, or sandbox" />
				<Connector />
				<Node label="receipt" detail="status, timing, checks, diff stat" />
			</div>
		</VisualShell>
	);
}

export function TwoFileVisual() {
	return (
			<VisualShell title="Start in one file, extract when it grows">
			<div className="doc-two-file">
				<div className="doc-visual-panel">
					<div className="doc-visual-panel-kicker">chit.config.json</div>
					<strong>default authoring surface</strong>
					<span>profiles.builder = codex:gpt-5.5</span>
					<span>routines.implement.steps</span>
					<span>repeat.until = checks-pass</span>
				</div>
				<div className="doc-binding-line">optional extraction</div>
				<div className="doc-visual-panel">
					<div className="doc-visual-panel-kicker">routines/implement.json</div>
					<strong>same routine shape</strong>
					<span>{"routines.implement.file -> routines/implement.json"}</span>
					<span>use this only when the routine is large</span>
				</div>
			</div>
		</VisualShell>
	);
}

export function GoalLoopVisual() {
	return (
		<VisualShell title="/goal as a routine">
			<div className="doc-loop">
				<Node label="goal" detail="the condition the user wants met" tone="dark" />
				<Connector />
				<Node label="worker" detail="tries the next change" />
				<Connector />
				<Node label="judge" detail="returns yes or no" />
				<div className="doc-loop-branches">
					<div className="doc-loop-branch">
						<span>yes</span>
						<Node label="receipt" detail="done" tone="muted" />
					</div>
					<div className="doc-loop-branch">
						<span>no</span>
						<Node label="next iteration" detail="feed the result back" tone="muted" />
					</div>
				</div>
			</div>
		</VisualShell>
	);
}

export function MultiModelPanelVisual() {
	return (
		<VisualShell title="Multi-model panel">
			<div className="doc-panel-flow">
				<Node label="question" detail="one prompt from the user" tone="dark" />
				<div className="doc-panel-grid">
					<Node label="model A" detail="simple answer" />
					<Node label="model B" detail="challenge and missing cases" />
				</div>
				<Connector label="both outputs feed" />
				<Node label="judge" detail="compare, choose, synthesize" />
				<Connector />
				<Node label="final answer" detail="one response, receipt included" tone="muted" />
			</div>
		</VisualShell>
	);
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

export function TerminalDemoVisual() {
	return (
		<VisualShell title="One run from the terminal">
			<div className="doc-terminal">
				<div className="doc-terminal-bar">terminal</div>
				<pre>
					<code>{`$ chit inspect feature-flow
steps: grill -> plan -> approve -> impl
	profiles: planner claude/sonnet, builder codex/gpt-5.5, critic gemini

$ chit run feature-flow --input idea="add a version command"
? Adjust the plan before implementation:
> keep the diff to the CLI and one test

converged in 1 iteration
	diff: src/cli.ts | 18 +
	receipt: run-a1b5efea
	
	$ chit apply run-a1b5efea
	$ chit trace run-a1b5efea`}</code>
				</pre>
			</div>
		</VisualShell>
	);
}
