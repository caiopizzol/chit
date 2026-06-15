// Mockup visuals for exploring a less-flat config reference (see /docs/mockups).
// Brand-styled (paper/ink, mono labels, shape-coded status) to match doc-visuals.tsx.
// EXPERIMENTAL: registered in components/mdx.tsx and styled under the "config mockup"
// block in app/chit-theme.css. Remove all three together when the direction is chosen.

import type { ReactNode } from "react";

const STEP_KINDS: { kind: string; fields: string; desc: string }[] = [
	{ kind: "call", fields: "id · call · prompt", desc: "Ask a routine agent. Stores its text output." },
	{ kind: "ask", fields: "id · ask", desc: "Pause for one operator answer. Fed forward, never stored." },
	{ kind: "check", fields: "id · check", desc: "Run one or more commands. Any check forces a sandbox." },
	{ kind: "format", fields: "id · format", desc: "Assemble text from templates and prior output." },
	{ kind: "routine", fields: "id · routine · inputs", desc: "Run another routine and store its output." },
];

export function StepKindGrid() {
	return (
		<div className="cfg-grid">
			{STEP_KINDS.map((s) => (
				<div key={s.kind} className="cfg-card">
					<div className="cfg-card-head">{s.kind}</div>
					<div className="cfg-chip">{s.fields}</div>
					<p>{s.desc}</p>
				</div>
			))}
		</div>
	);
}

const FS_LEVELS: { name: string; note: string; tone?: "muted" | "dark" }[] = [
	{ name: "none", note: "No file tools given to the adapter.", tone: "muted" },
	{ name: "read-only", note: "Inspect files. Every write tool is disallowed." },
	{ name: "read-write", note: "May edit. Runs in a disposable git worktree first.", tone: "dark" },
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

const LOOP_CONDITIONS: { title: string; code: string; when: string }[] = [
	{ title: "checks pass", code: `"checks-pass"`, when: "Deterministic. The default. Falls back to 5 iterations." },
	{ title: "step equals", code: `{ "step": "review", "equals": "pass" }`, when: "A model or human verdict ends the loop. Needs a cap." },
	{ title: "all", code: `{ "all": ["checks-pass", { "step": "review", "equals": "pass" }] }`, when: "Both must hold. A reviewer can block convergence." },
];

export function LoopConditionCards() {
	return (
		<div className="cfg-grid cfg-grid-3">
			{LOOP_CONDITIONS.map((c) => (
				<div key={c.title} className="cfg-card">
					<div className="cfg-card-head">{c.title}</div>
					<pre className="cfg-card-code">{c.code}</pre>
					<p>{c.when}</p>
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
        "builder": { "profile": "builder", "filesystem": "read-write" },
        "critic":  { "profile": "critic",  "filesystem": "read-only" }
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

const REJECTS: { example: string; reason: string }[] = [
	{ example: `"x": "codex:sonnet"`, reason: "sonnet is a Claude model, not a codex one" },
	{ example: `"x": "codex:"`, reason: "trailing colon, no model: use \"codex\"" },
	{ example: `"x": "ollama:llama3"`, reason: "unknown adapter: custom adapters use object form" },
	{ example: `{ "file": "../secret.json" }`, reason: "a routine file cannot escape the project" },
	{ example: `{ "until": { "step": "review", "equals": "pass" } }`, reason: "a judged loop must set maxIterations" },
];

export function RejectList() {
	return (
		<div className="cfg-reject">
			{REJECTS.map((r) => (
				<div key={r.example} className="cfg-reject-row">
					<span className="cfg-reject-shape">◆</span>
					<code className="cfg-reject-ex">{r.example}</code>
					<span className="cfg-reject-why">{r.reason}</span>
				</div>
			))}
		</div>
	);
}
