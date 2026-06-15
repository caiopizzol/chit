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

const DERIVED: { shape: string; cond: ReactNode; behavior: string }[] = [
	{ shape: "○", cond: <>pure read-only <code>call</code> / <code>format</code></>, behavior: "text run, in your cwd" },
	{ shape: "○", cond: <><code>routine</code> steps</>, behavior: "composition, outputs passed forward" },
	{ shape: "◐", cond: <>a <code>repeat</code></>, behavior: "loop, until the stop condition" },
	{ shape: "●", cond: <>a <code>check</code> or a read-write agent</>, behavior: "sandboxed, in a git worktree" },
];

export function DerivedBehavior() {
	return (
		<div className="doc-visual">
			<div className="doc-visual-title">How it runs is derived, not chosen</div>
			<div className="cfg-derive">
				{DERIVED.map((d, i) => (
					<div key={i} className="cfg-derive-row">
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

const ANNOTATIONS: { field: string; note: string }[] = [
	{ field: "profiles", note: "Names bound to local adapters and models. Machine-local." },
	{ field: "agents", note: "The actors in this routine. Each points at a profile." },
	{ field: "filesystem: read-write", note: "May edit, so the run is sandboxed in a worktree." },
	{ field: "steps", note: "Ordered. The non-id field picks the kind." },
	{ field: "check", note: "Any check forces a sandbox and gates the loop." },
	{ field: "repeat.until", note: "The loop's exit condition. Yours to declare." },
];

const ANNOTATED_CONFIG = `{
  "profiles": {
    "builder": "codex:gpt-5.5",
    "critic": "gemini"
  },
  "routines": {
    "implement": {
      "input": "task",
      "agents": {
        "builder": { "profile": "builder", "instructions": "Implement it.", "filesystem": "read-write" },
        "critic":  { "profile": "critic",  "instructions": "Review the diff.", "filesystem": "read-only" }
      },
      "steps": [
        { "id": "build",  "call": "builder", "prompt": "{{ inputs.task }}" },
        { "id": "review", "call": "critic",  "prompt": "{{ diff }}" },
        { "id": "verify", "check": "bun test" }
      ],
      "repeat": { "until": "checks-pass", "maxIterations": 3 }
    }
  }
}`;

export function AnnotatedConfig() {
	return (
		<div className="cfg-annotated">
			<pre className="cfg-annotated-code">{ANNOTATED_CONFIG}</pre>
			<div className="cfg-annotated-notes">
				{ANNOTATIONS.map((a) => (
					<div key={a.field} className="cfg-note">
						<span className="cfg-mono">{a.field}</span>
						<span>{a.note}</span>
					</div>
				))}
			</div>
		</div>
	);
}
