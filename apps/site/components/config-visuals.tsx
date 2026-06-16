// Visuals for the config reference (/docs/config). Brand-styled (paper/ink, mono
// labels, shape-coded status) to match doc-visuals.tsx. Styled under the "config
// reference visuals" block in app/chit-theme.css.

import type { ReactNode } from "react";

const FS_LEVELS: { name: string; note: string; tone?: "mid" | "strong" }[] = [
	{ name: "none", note: "No file tools given to the adapter." },
	{ name: "read-only", note: "Inspect files. Every write tool is disallowed.", tone: "mid" },
	{ name: "read-write", note: "May edit. Runs in a disposable git worktree first.", tone: "strong" },
];

export function FilesystemScale() {
	return (
		<div className="cfg-scale">
			{FS_LEVELS.map((l, i) => (
				<div key={l.name} className={`cfg-scale-seg${l.tone ? ` cfg-scale-${l.tone}` : ""}`}>
					<div className="cfg-scale-head">
						<span className="cfg-scale-rank">{i + 1}</span>
						<span className="cfg-mono">{l.name}</span>
					</div>
					<p>{l.note}</p>
				</div>
			))}
		</div>
	);
}

const DERIVED: { id: string; shape: string; cond: ReactNode; behavior: string }[] = [
	{
		id: "text",
		shape: "○",
		cond: (
			<>
				pure read-only <code>call</code> / <code>format</code>
			</>
		),
		behavior: "text run, in your cwd",
	},
	{
		id: "composition",
		shape: "○",
		cond: (
			<>
				<code>routine</code> steps
			</>
		),
		behavior: "composition, outputs passed forward",
	},
	{
		id: "loop",
		shape: "◐",
		cond: (
			<>
				a <code>repeat</code>
			</>
		),
		behavior: "loop, until the stop condition",
	},
	{
		id: "sandbox",
		shape: "●",
		cond: (
			<>
				a <code>check</code> or a read-write agent
			</>
		),
		behavior: "sandboxed, in a git worktree",
	},
];

export function DerivedBehavior() {
	return (
		<div className="doc-visual">
			<div className="doc-visual-title">How it runs is derived, not chosen</div>
			<div className="cfg-derive">
				{DERIVED.map((d) => (
					<div key={d.id} className="cfg-derive-row">
						<span className="cfg-derive-shape">{d.shape}</span>
						<span className="cfg-derive-cond">{d.cond}</span>
						<span className="cfg-derive-arrow">-&gt;</span>
						<span className="cfg-derive-behavior">{d.behavior}</span>
					</div>
				))}
			</div>
		</div>
	);
}
