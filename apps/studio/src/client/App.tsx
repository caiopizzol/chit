// Top-level App. Switches on ClientState.mode and renders the right
// surface: OpenMode (canvas + always-visible right rail with validation
// panel above a read-only JSON inspector), PickerMode, ErrorMode, or
// EmptyMode. Header carries the file label and a surface selector that
// triggers an authenticated POST /api/documents/:docId/preview on
// change; the server runs parseManifest + buildGraphModel against the
// in-memory draftSource and returns a fresh GraphModel. The graph
// adapter derives per-call warn indicators from
// validation.permissions.gaps so node badges and the validation panel
// stay in sync. Nodes are click-to-inspect, not drag-to-arrange:
// selection is sticky, the cursor is pointer, and selected nodes get an
// inverted header strip plus an outer ink outline.

import type {
	AdapterUsage,
	AuditEvent,
	LoopRecord,
	LoopStopStatus,
	SurfaceKind,
	ValidationReport,
} from "@chit/core";
import { formatAdapterUsage } from "@chit/core";
import {
	applyEdgeChanges,
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	type EdgeChange,
	type Node,
	ReactFlow,
	useNodesInitialized,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type DiffRow, lineDiff } from "./diff.ts";
import { canonicalize, referenceToken } from "./editor.ts";
import { layoutNodes } from "./elk.ts";
import { adaptGraphModel } from "./graphAdapter.ts";
import type { CallData, FormatData, InputData } from "./nodes.tsx";
import { nodeTypes } from "./nodes.tsx";
import type {
	ClientState,
	OpenClientState,
	OpenErrorClientState,
	PickerClientState,
} from "./state.ts";
import { useDocumentEditor } from "./useDocumentEditor.ts";
import { useInstalled } from "./useInstalled.ts";
import { type LoopsState, useLoops } from "./useLoops.ts";

const SURFACES: SurfaceKind[] = ["claude-skill", "cli"];

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

type RowState = "ok" | "warn" | "fail";
const ROW_SYMBOL: Record<RowState, string> = { ok: "●", warn: "○", fail: "◆" };

function permissionsRowState(s: "ok" | "needs_override" | "blocked"): RowState {
	if (s === "ok") return "ok";
	if (s === "needs_override") return "warn";
	return "fail";
}

function ValidationPanel({ validation }: { validation: ValidationReport | null }) {
	if (!validation) {
		return (
			<section className="vpanel">
				<h2>Validation</h2>
				<p className="empty">Pick a surface to validate against.</p>
			</section>
		);
	}
	const caps: RowState = validation.capabilities.compatible ? "ok" : "fail";
	const agents: RowState = validation.agents.resolved ? "ok" : "fail";
	const perms: RowState = permissionsRowState(validation.permissions.status);
	const capsDetail = validation.capabilities.compatible
		? "all required present"
		: `missing: ${validation.capabilities.missing.join(", ")}`;
	const agentsDetail = validation.agents.resolved
		? "all resolved"
		: `unknown: ${validation.agents.unknown.map((u) => u.agentId).join(", ")}`;
	const gapCount = validation.permissions.gaps.length;
	const permsDetail =
		gapCount === 0
			? "all enforceable"
			: `${gapCount} gap${gapCount === 1 ? "" : "s"}: ${validation.permissions.gaps
					.map((g) => g.participantId)
					.join(", ")}`;
	return (
		<section className="vpanel">
			<h2>Validation</h2>
			<VRow label="Capabilities" state={caps} detail={capsDetail} />
			<VRow label="Agents" state={agents} detail={agentsDetail} />
			<VRow label="Permissions" state={perms} detail={permsDetail} />
		</section>
	);
}

function VRow({ label, state, detail }: { label: string; state: RowState; detail: string }) {
	return (
		<div className={`vrow vrow--${state}`}>
			<span className="vrow-symbol">{ROW_SYMBOL[state]}</span>
			<span className="vrow-label">{label}</span>
			<span className="vrow-detail">{detail}</span>
		</div>
	);
}

const SESSIONS = ["stateless", "per_topology", "per_scope"];
const FILESYSTEMS = ["read_only", "write"];

// Editable inspector for a selected call node. Values are read from
// draftSource (the in-progress edit), NOT from the node's graphModel data,
// which lags by the debounce. Edits funnel through setStepField /
// setParticipantField, the same lifecycle as the description edit. `prompt`
// is a step field; role/session/filesystem are participant fields.
function CallInspector({
	data,
	draftSource,
	onParticipantField,
	onStepField,
}: {
	data: CallData;
	draftSource: Record<string, unknown>;
	onParticipantField: (
		participantId: string,
		field: "role" | "session" | "filesystem",
		value: string,
	) => void;
	onStepField: (stepId: string, field: "prompt" | "format", value: string) => void;
}) {
	const pid = data.participantId;
	const steps = (draftSource.steps ?? {}) as Record<string, Record<string, unknown>>;
	const prompt = String(steps[data.id]?.prompt ?? "");
	const participants = (draftSource.participants ?? {}) as Record<string, Record<string, unknown>>;
	const p = participants[pid] ?? {};
	const role = String(p.role ?? "");
	const session = String(p.session ?? "stateless");
	const filesystem = String(
		((p.permissions as Record<string, unknown> | undefined)?.filesystem ?? "read_only") as string,
	);
	const agent = String(p.agent ?? data.agent);
	return (
		<section className="inspector">
			<h2>Inspector · call</h2>
			<div className="field">
				<div className="field-label">step</div>
				<div className="field-value">{data.id}</div>
			</div>
			<div className="field">
				<div className="field-label">participant</div>
				<div className="field-value">{pid}</div>
			</div>
			<div className="field">
				<div className="field-label">agent (read-only)</div>
				<div className="field-value">{agent}</div>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-prompt">
					prompt
				</label>
				<textarea
					id="call-prompt"
					className="inspector-input"
					value={prompt}
					rows={5}
					spellCheck={false}
					onChange={(e) => onStepField(data.id, "prompt", e.currentTarget.value)}
				/>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-role">
					role
				</label>
				<textarea
					id="call-role"
					className="inspector-input"
					value={role}
					rows={3}
					spellCheck={false}
					onChange={(e) => onParticipantField(pid, "role", e.currentTarget.value)}
				/>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-session">
					session
				</label>
				<select
					id="call-session"
					className="inspector-select"
					value={session}
					onChange={(e) => onParticipantField(pid, "session", e.currentTarget.value)}
				>
					{SESSIONS.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="call-filesystem">
					filesystem
				</label>
				<select
					id="call-filesystem"
					className="inspector-select"
					value={filesystem}
					onChange={(e) => onParticipantField(pid, "filesystem", e.currentTarget.value)}
				>
					{FILESYSTEMS.map((f) => (
						<option key={f} value={f}>
							{f}
						</option>
					))}
				</select>
			</div>
		</section>
	);
}

// Editable inspector for a selected format node: the `format` template, plus
// read-only step id / output marker / ref count. Output designation (the
// manifest `output` field) is a later concern; 3.0 edits the template text.
function FormatInspector({
	data,
	draftSource,
	onStepField,
}: {
	data: FormatData;
	draftSource: Record<string, unknown>;
	onStepField: (stepId: string, field: "prompt" | "format", value: string) => void;
}) {
	const steps = (draftSource.steps ?? {}) as Record<string, Record<string, unknown>>;
	const format = String(steps[data.id]?.format ?? "");
	return (
		<section className="inspector">
			<h2>Inspector · format</h2>
			<div className="field">
				<div className="field-label">step</div>
				<div className="field-value">{data.id}</div>
			</div>
			<div className="field">
				<div className="field-label">output (read-only)</div>
				<div className="field-value">{data.isOutput ? "yes" : "no"}</div>
			</div>
			<div className="field">
				<label className="field-label" htmlFor="format-template">
					format
				</label>
				<textarea
					id="format-template"
					className="inspector-input"
					value={format}
					rows={6}
					spellCheck={false}
					onChange={(e) => onStepField(data.id, "format", e.currentTarget.value)}
				/>
			</div>
		</section>
	);
}

function Inspector({
	selected,
	draftSource,
	onParticipantField,
	onStepField,
}: {
	selected: Node | null;
	draftSource: Record<string, unknown>;
	onParticipantField: (
		participantId: string,
		field: "role" | "session" | "filesystem",
		value: string,
	) => void;
	onStepField: (stepId: string, field: "prompt" | "format", value: string) => void;
}) {
	if (!selected) {
		return (
			<section className="inspector">
				<h2>Inspector</h2>
				<p className="empty">Select a node to inspect.</p>
			</section>
		);
	}
	if (selected.type === "call") {
		return (
			<CallInspector
				data={selected.data as CallData}
				draftSource={draftSource}
				onParticipantField={onParticipantField}
				onStepField={onStepField}
			/>
		);
	}
	if (selected.type === "format") {
		return (
			<FormatInspector
				data={selected.data as FormatData}
				draftSource={draftSource}
				onStepField={onStepField}
			/>
		);
	}
	// input: read-only field dump (input name/type/required editing is a later
	// slice).
	const fields = Object.entries(selected.data as Record<string, unknown>);
	return (
		<section className="inspector">
			<h2>Inspector · {selected.type}</h2>
			{fields.map(([k, v]) => (
				<div className="field" key={k}>
					<div className="field-label">{k}</div>
					<div className="field-value">{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
				</div>
			))}
		</section>
	);
}

function SurfaceSelector({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (next: SurfaceKind) => void;
	disabled: boolean;
}) {
	return (
		<span className="surface-control">
			surface:&nbsp;
			<select
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.currentTarget.value as SurfaceKind)}
			>
				{SURFACES.map((s) => (
					<option key={s} value={s}>
						{s}
					</option>
				))}
			</select>
		</span>
	);
}

// Editable manifest-level fields. 2.2 ships only `description`; role,
// session, filesystem land in 2.3. Always visible (independent of node
// selection) so editing never requires deselecting a node.
function ManifestPanel({
	description,
	onDescriptionChange,
}: {
	description: string;
	onDescriptionChange: (value: string) => void;
}) {
	return (
		<section className="manifest-panel">
			<h2>Manifest</h2>
			<label className="field-label" htmlFor="manifest-description">
				description
			</label>
			<textarea
				id="manifest-description"
				className="manifest-description"
				value={description}
				onChange={(e) => onDescriptionChange(e.currentTarget.value)}
				rows={3}
				spellCheck={false}
			/>
		</section>
	);
}

function DiffModal({
	relPath,
	before,
	after,
	saving,
	onConfirm,
	onCancel,
}: {
	relPath: string;
	before: string;
	after: string;
	saving: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const rows: DiffRow[] = useMemo(() => lineDiff(before, after), [before, after]);
	// Escape closes the modal. A document-level listener (not an onKeyDown on
	// the overlay div, which never receives focus) is the reliable path.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	const sym = { same: " ", add: "+", del: "-" };
	return (
		<div className="modal-overlay">
			{/* Backdrop is a real button: click-to-dismiss is keyboard-accessible
			    for free, and being a sibling (not an ancestor) of the dialog means
			    no stopPropagation is needed on the dialog itself. */}
			<button type="button" className="modal-backdrop" aria-label="Cancel" onClick={onCancel} />
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={`Review changes to ${relPath}`}
			>
				<h2>
					Write changes to <code className="modal-path">{relPath}</code>?
				</h2>
				<pre className="diff">
					{rows.map((r, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional and the list is static while the modal is open
							key={i}
							className={`diff-row diff-row--${r.type}`}
						>
							<span className="diff-gutter">{sym[r.type]}</span>
							<span className="diff-text">{r.text}</span>
						</div>
					))}
				</pre>
				<div className="modal-actions">
					<button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
						Cancel
					</button>
					<button type="button" className="btn-primary" onClick={onConfirm} disabled={saving}>
						{saving ? "Writing…" : "Write to disk"}
					</button>
				</div>
			</div>
		</div>
	);
}

// Install-review modal: confirm publishing the current chit into Claude Code.
// The target is fixed (the Claude Code skill surface, not the validation-
// surface picker). The modal opens only when install is allowed (clean, saved,
// conflict-free, parseable) — that gate lives on the header button. Permission
// consent appears only when the chit has enforcement gaps, tied to the specific
// warning rather than a vague global toggle. Mirrors --allow-unenforced-permissions.
function InstallModal({
	relPath,
	gaps,
	busy,
	error,
	onConfirm,
	onCancel,
}: {
	relPath: string;
	gaps: Array<{ participantId: string; agentId: string; permission: string }>;
	busy: boolean;
	error: string | null;
	onConfirm: (allowUnenforcedPermissions: boolean) => void;
	onCancel: () => void;
}) {
	const [consent, setConsent] = useState(false);
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	const needsConsent = gaps.length > 0;
	const canConfirm = (!needsConsent || consent) && !busy;
	return (
		<div className="modal-overlay">
			<button type="button" className="modal-backdrop" aria-label="Cancel" onClick={onCancel} />
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={`Install ${relPath} into Claude Code`}
			>
				<h2>
					Install <code className="modal-path">{relPath}</code> into Claude Code?
				</h2>
				<p className="modal-note">
					Publishes this chit as a Claude Code skill on this machine. The saved file is the source.
				</p>
				{error && <div className="refetch-error">{error}</div>}
				{needsConsent && (
					<div className="consent">
						<label className="allow-unenforced">
							<input
								type="checkbox"
								checked={consent}
								onChange={(e) => setConsent(e.currentTarget.checked)}
							/>
							Install with permission warning
						</label>
						{gaps.map((g) => (
							<p key={`${g.participantId}:${g.permission}`} className="consent-gap">
								Claude Code cannot enforce {g.permission} for {g.participantId}.
							</p>
						))}
					</div>
				)}
				<div className="modal-actions">
					<button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
						Cancel
					</button>
					<button
						type="button"
						className="btn-primary"
						onClick={() => onConfirm(needsConsent && consent)}
						disabled={!canConfirm}
					>
						{busy ? "Installing…" : "Install"}
					</button>
				</div>
			</div>
		</div>
	);
}

// Installed registry: what this machine has published, independent of the open
// chit. A right-side drawer (not a rail panel) — it answers "what has this
// machine published?", a different altitude from the per-chit inspector. Per-
// row uninstall is a two-step confirm; empty state when nothing is installed.
function InstalledDrawer({
	list,
	busy,
	error,
	onUninstall,
	onClose,
}: {
	list: Array<{ name: string; surface: string; manifestId: string; installedAt: string }>;
	busy: boolean;
	error: string | null;
	onUninstall: (name: string) => void;
	onClose: () => void;
}) {
	const [confirming, setConfirming] = useState<string | null>(null);
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="drawer-overlay">
			<button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
			<aside className="drawer" role="dialog" aria-modal="true" aria-label="Installed chits">
				<header className="drawer-head">
					<h2>Installed</h2>
					<button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				{error && <div className="refetch-error">{error}</div>}
				<ul className="installed-list">
					{list.length === 0 && <li className="empty">No chits installed on this machine.</li>}
					{list.map((i) => (
						<li key={i.name} className="installed-item">
							<code>{i.name}</code>
							<span className="installed-surface">{i.surface}</span>
							{confirming === i.name ? (
								<span className="confirm-row">
									<button
										type="button"
										className="btn-secondary"
										onClick={() => {
											onUninstall(i.name);
											setConfirming(null);
										}}
									>
										Confirm
									</button>
									<button
										type="button"
										className="btn-secondary"
										onClick={() => setConfirming(null)}
									>
										Cancel
									</button>
								</span>
							) : (
								<button
									type="button"
									className="btn-secondary"
									onClick={() => setConfirming(i.name)}
									disabled={busy}
								>
									Uninstall
								</button>
							)}
						</li>
					))}
				</ul>
			</aside>
		</div>
	);
}

function fmtElapsed(ms: number | null): string {
	if (ms === null) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// The compact iteration rail for one loop, rendered from its records. The
// server already validated structure/consistency; this only reads.
// A loop iteration's detailsRef is "audit:<runId>" when the run was audited.
// Returns the runId, or undefined for an unaudited iteration.
function auditRunIdOf(detailsRef: string | undefined): string | undefined {
	const m = detailsRef?.match(/^audit:(.+)$/);
	return m?.[1];
}

function LoopRail({
	records,
	onOpenAudit,
}: {
	records: LoopRecord[];
	onOpenAudit?: (runId: string) => void;
}) {
	const header = records.find((r) => r.type === "loop");
	const stop = records.find((r) => r.type === "stop");
	const iterations = records.filter((r) => r.type === "iteration");
	const status = stop?.type === "stop" ? stop.status : "in-progress";
	return (
		<div className="loop-rail">
			{header?.type === "loop" && (
				<div className="rail-head">
					<div className="rail-head-top">
						<span className={`loop-status loop-status--${status}`}>{status}</span>
						<span className="rail-meta">
							{iterations.length} iterations ·{" "}
							{fmtElapsed(stop?.type === "stop" ? stop.totalElapsedMs : null)}
						</span>
					</div>
					<p className="rail-scope">{header.scope}</p>
					<p className="rail-task">{header.task}</p>
				</div>
			)}
			<ol className="rail-iters">
				{iterations.map(
					(it) =>
						it.type === "iteration" && (
							<li key={it.n} className="rail-iter">
								<div className="rail-line">
									<span className="rail-n">{it.n}</span> {it.implementSummary}
								</div>
								<div className="rail-sub">
									{it.changedFiles.length} files
									{it.changedFiles.length > 0 ? `: ${it.changedFiles.join(", ")}` : ""}
								</div>
								<div className="rail-sub">checks: {it.checksRun}</div>
								<div className="rail-sub">
									check <span className={`verdict verdict--${it.verdict}`}>{it.verdict}</span> ·{" "}
									{Math.round(it.checkDurationMs / 1000)}s · {it.findingCount} findings
								</div>
								<div className="rail-sub">decide {it.decision}</div>
								{(() => {
									const runId = auditRunIdOf(it.detailsRef);
									return runId && onOpenAudit ? (
										<button
											type="button"
											className="rail-audit-link"
											onClick={() => onOpenAudit(runId)}
										>
											view transcript →
										</button>
									) : null;
								})()}
							</li>
						),
				)}
			</ol>
			{stop?.type === "stop" && (
				<div className="rail-stop">
					✓ stopped: {stop.status} ({stop.reason})
				</div>
			)}
		</div>
	);
}

const STOP_LABEL: Record<LoopStopStatus, string> = {
	converged: "converged",
	blocked: "blocked",
	"max-iterations": "max iterations",
	"needs-decision": "needs decision",
};

// Compact convergence shape: one chip per iteration showing the loop owner's
// decision (proceed/revise/block - what was chosen after review, not the raw
// verdict), then a final chip for the stop status. Complements the rail's
// chronological detail with an at-a-glance read of how the loop converged.
function VerdictTrail({ records }: { records: LoopRecord[] }) {
	const iterations = records.filter((r) => r.type === "iteration");
	const stop = records.find((r) => r.type === "stop");
	return (
		<div className="verdict-trail">
			{iterations.map(
				(it) =>
					it.type === "iteration" && (
						<span
							key={it.n}
							className={`trail-chip trail-chip--${it.decision}`}
							title={`iteration ${it.n}: decided ${it.decision}`}
						>
							{it.decision}
						</span>
					),
			)}
			{stop?.type === "stop" && (
				<span className={`trail-chip trail-stop trail-stop--${stop.status}`}>
					{STOP_LABEL[stop.status] ?? stop.status}
				</span>
			)}
		</div>
	);
}

// Per-loop config strip, shown atop the detail view. Reads the loop's header
// record (scope/repo/startedAt/maxIterations). The convergence log does not
// record which checker manifest the loop ran against, so that row is labeled
// "not recorded" rather than invented.
function LoopConfig({ header }: { header: LoopRecord & { type: "loop" } }) {
	return (
		<dl className="loop-config">
			<div className="config-row">
				<dt>scope</dt>
				<dd>{header.scope}</dd>
			</div>
			<div className="config-row">
				<dt>repo</dt>
				<dd>{header.repo}</dd>
			</div>
			<div className="config-row">
				<dt>started</dt>
				<dd>{header.startedAt}</dd>
			</div>
			<div className="config-row">
				<dt>max iterations</dt>
				<dd>{header.maxIterations}</dd>
			</div>
			<div className="config-row">
				<dt>checker manifest</dt>
				<dd className="config-absent">not recorded</dd>
			</div>
		</dl>
	);
}

// Static explainer for the supervised-convergence policy. Presentational only:
// the implement -> check -> decide loop as a small diagram plus the conditions
// that stop it. Shown above the loop list so the history below reads against the
// rules that produced it. This is fixed copy; per-loop config (scope,
// maxIterations, etc.) is shown by LoopConfig in the detail view.
function LoopPolicy() {
	const stages = ["Implement", "Check", "Decide"];
	const stops = [
		"Proceed + task complete",
		"Block / human input needed",
		"An ambiguous decision",
		"Max iterations reached",
	];
	return (
		<section className="loop-policy">
			<h3 className="loop-policy-head">Loop policy</h3>
			<div className="policy-flow">
				{stages.map((stage, i) => (
					<span key={stage} className="policy-flow-step">
						<span className="policy-stage">{stage}</span>
						{i < stages.length - 1 && <span className="policy-arrow">→</span>}
					</span>
				))}
			</div>
			<div className="policy-repeat">↻ repeat until it converges or needs you</div>
			<div className="policy-stops">
				<span className="policy-stops-label">Stops when</span>
				<ul className="policy-stops-list">
					{stops.map((s) => (
						<li key={s}>{s}</li>
					))}
				</ul>
			</div>
		</section>
	);
}

const USAGE_KEYS: (keyof AdapterUsage)[] = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
	"reasoningTokens",
	"estimatedCostUsd",
];

// Sum adapter-call token usage across a run, then render it with the shared
// @chit/core formatter so the Studio and CLI views never drift.
function renderAuditUsage(events: AuditEvent[]): string {
	const usage: AdapterUsage = {};
	let any = false;
	for (const e of events) {
		if (e.type !== "adapter.call.completed" || !e.usage) continue;
		for (const k of USAGE_KEYS) {
			const v = e.usage[k];
			if (typeof v === "number") {
				usage[k] = (usage[k] ?? 0) + v;
				any = true;
			}
		}
	}
	return formatAdapterUsage(any ? usage : undefined);
}

// The blob ref an event references (prompt, output, raw), if any.
function eventBlobRef(e: AuditEvent): string | undefined {
	if (e.type === "adapter.call.started") return e.inputBlob;
	if (e.type === "adapter.call.completed") return e.outputBlob;
	if (e.type === "step.completed") return e.outputBlob;
	if (e.type === "adapter.event") return e.rawBlob;
	return undefined;
}

function auditEventLine(e: AuditEvent): string {
	switch (e.type) {
		case "run.started":
			return `run.started · ${e.manifestId} (${e.surface})`;
		case "step.started":
			return `step.started · ${e.stepId} (${e.kind})`;
		case "adapter.call.started":
			return `adapter.call.started · ${e.stepId} ${e.participantId}/${e.agentId}`;
		case "adapter.call.completed":
			return `adapter.call.completed · ${e.stepId} ${e.status} · ${e.durationMs}ms`;
		case "adapter.event":
			return `adapter.event · ${e.stepId} ${e.eventType}`;
		case "step.completed":
			return `step.completed · ${e.stepId} ${e.durationMs}ms`;
		case "step.failed":
			return `step.failed · ${e.stepId} ${e.durationMs}ms · ${e.error}`;
		case "loop.iteration.recorded":
			return `loop.iteration.recorded · n=${e.n} ${e.verdict}`;
		case "run.completed":
			return `run.completed · ${e.status} ${e.durationMs}ms`;
	}
}

// The audit transcript for one run: header (surface/manifest/status + an
// INCOMPLETE flag when there is no run.completed), a usage summary, and the
// event timeline. Prompt/output bodies are collapsed by default.
function AuditView({ events, blobs }: { events: AuditEvent[]; blobs: Record<string, string> }) {
	const started = events.find((r) => r.type === "run.started");
	const completed = events.find((r) => r.type === "run.completed");
	const status = completed?.type === "run.completed" ? completed.status : "incomplete";
	return (
		<div className="audit-view">
			<div className="audit-head">
				{started?.type === "run.started" && (
					<p className="audit-meta">
						{started.surface} · {started.manifestId}
						{started.scope ? ` · ${started.scope}` : ""}
					</p>
				)}
				<p className="audit-status">
					status: <span className={`audit-status--${status}`}>{status}</span>
					{status === "incomplete" ? " (no run.completed: failed, cancelled, or abandoned)" : ""}
				</p>
				<p className="audit-usage">{renderAuditUsage(events)}</p>
			</div>
			<ol className="audit-timeline">
				{events.map((e, i) => {
					const ref = eventBlobRef(e);
					const body = ref !== undefined ? blobs[ref] : undefined;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: the audit timeline is append-only and never reordered
						<li key={i} className="audit-event">
							<div className="audit-line">{auditEventLine(e)}</div>
							{body !== undefined && (
								<details className="audit-body">
									<summary>body ({body.length} chars)</summary>
									<pre>{body}</pre>
								</details>
							)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}

function LoopsDrawer({ loops, onClose }: { loops: LoopsState; onClose: () => void }) {
	const { list, detail, audit, select, clearSelection, selectAudit, clearAudit } = loops;
	const inDetail = detail.status !== "idle";
	const inAudit = audit.status !== "idle";
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			// Escape backs out one level at a time: audit -> loop detail -> list -> close.
			if (inAudit) clearAudit();
			else if (inDetail) clearSelection();
			else onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, clearSelection, clearAudit, inDetail, inAudit]);

	// The idle/list sub-states, rendered below the static LoopPolicy explainer.
	function listBody() {
		if (list.status === "loading") return <div className="empty">Loading…</div>;
		if (list.status === "error") return <div className="refetch-error">{list.error}</div>;
		if (list.loops.length === 0) {
			return <div className="empty">No loops recorded in this directory.</div>;
		}
		return (
			<ul className="loop-list">
				{list.loops.map((l) => (
					<li key={l.loopId}>
						<button type="button" className="loop-item" onClick={() => void select(l.loopId)}>
							<span className="loop-task">{l.task}</span>
							<span className="loop-meta">
								<span className={`loop-status loop-status--${l.status}`}>{l.status}</span>{" "}
								{l.iterations} iters · {fmtElapsed(l.totalElapsedMs)}
							</span>
						</button>
					</li>
				))}
			</ul>
		);
	}

	function body() {
		// An open audit transcript takes over the detail pane (it was reached from
		// a loop iteration); backing out returns to the loop.
		if (inAudit) {
			if (audit.status === "loading") return <div className="empty">Loading…</div>;
			if (audit.status === "error") return <div className="refetch-error">{audit.error}</div>;
			if (audit.status === "ready") {
				return <AuditView events={audit.events} blobs={audit.blobs} />;
			}
		}
		if (detail.status === "loading") return <div className="empty">Loading…</div>;
		if (detail.status === "error") return <div className="refetch-error">{detail.error}</div>;
		if (detail.status === "ready") {
			const header = detail.records.find((r) => r.type === "loop");
			return (
				<>
					{header?.type === "loop" && <LoopConfig header={header} />}
					<VerdictTrail records={detail.records} />
					<LoopRail records={detail.records} onOpenAudit={(runId) => void selectAudit(runId)} />
				</>
			);
		}
		// detail idle -> the static policy explainer above the loop list
		return (
			<>
				<LoopPolicy />
				{listBody()}
			</>
		);
	}

	return (
		<div className="drawer-overlay">
			<button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
			<aside className="drawer" role="dialog" aria-modal="true" aria-label="Loops">
				<header className="drawer-head">
					{inAudit ? (
						<button type="button" className="drawer-back" onClick={clearAudit}>
							← Loop
						</button>
					) : inDetail ? (
						<button type="button" className="drawer-back" onClick={clearSelection}>
							← Loops
						</button>
					) : (
						<h2>Loops</h2>
					)}
					<button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				{body()}
			</aside>
		</div>
	);
}

function ConflictBanner({ onReload }: { onReload: () => void }) {
	return (
		<div className="conflict-banner">
			<span>
				This file changed on disk since it was opened. Save is blocked to avoid clobbering the other
				change.
			</span>
			<button type="button" className="btn-primary" onClick={onReload}>
				Reload from disk
			</button>
		</div>
	);
}

// A target node can receive a reference (it has a template). Inputs cannot.
function isTargetable(type: string | undefined): boolean {
	return type === "call" || type === "format";
}

function OpenMode({ initial }: { initial: OpenClientState }) {
	const editor = useDocumentEditor(initial);
	const installed = useInstalled(initial.docId);
	const loops = useLoops();
	const [diffOpen, setDiffOpen] = useState(false);
	const [edgeError, setEdgeError] = useState<string | null>(null);
	const [installOpen, setInstallOpen] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [loopsOpen, setLoopsOpen] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [installConflict, setInstallConflict] = useState(false);

	const adapted = useMemo(() => adaptGraphModel(editor.graphModel), [editor.graphModel]);
	const [nodes, setNodes] = useState<Node[]>([]);
	// Edges are local state (not the adapted array directly) so React Flow can
	// apply edge selection — selection is the Delete/Backspace target for
	// delete-edge. Re-seeded from the parsed graph whenever it changes; on a
	// successful disconnect the graph re-derivation removes the edge here.
	const [edges, setEdges] = useState<Edge[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		layoutNodes(adapted.nodes, adapted.edges, adapted.sizes).then(setNodes);
	}, [adapted]);

	useEffect(() => {
		setEdges(adapted.edges as Edge[]);
	}, [adapted.edges]);

	const onSelectionChange = useCallback(
		({ nodes: sel }: { nodes: Node[] }) => setSelectedId(sel[0]?.id ?? null),
		[],
	);

	// Explicit click handler because React Flow's click→select handler does
	// not always fire when nodesDraggable=false (the drag+select gesture
	// path is the one that updates the internal selection on click).
	// Keyboard Enter still works through React Flow's a11y handler.
	const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
		setSelectedId(node.id);
	}, []);

	// Whether an edge source -> target already exists, by parsed-graph
	// semantics (adapted.edges derives from graphModel.edges, the parsed
	// refs). This catches a hand-written `{{steps.x.output}}` that differs
	// from the canonical token only in spacing — string inclusion in
	// insertReference would not.
	const edgeExists = useCallback(
		(source: string, target: string) =>
			adapted.edges.some((e) => e.source === source && e.target === target),
		[adapted.edges],
	);

	// Advisory pre-check before onConnect runs. Cheap rejections only; the
	// authority is parseManifest on the candidate draft (inside editor.connect).
	const isValidConnection = useCallback(
		(conn: Connection | { source: string | null; target: string | null }) => {
			if (!conn.source || !conn.target) return false;
			if (conn.source === conn.target) return false; // a step cannot ref its own output
			const target = nodes.find((n) => n.id === conn.target);
			if (!isTargetable(target?.type)) return false;
			return !edgeExists(conn.source, conn.target); // no duplicate edges
		},
		[nodes, edgeExists],
	);

	// Drag-to-connect. Derive the reference token from the source node (input
	// ref vs step-output ref) and hand off to editor.connect, which validates
	// the candidate via parseManifest and commits on accept. The graph re-
	// renders the new edge once the immediate preview returns.
	const onConnect = useCallback(
		(conn: Connection) => {
			const source = nodes.find((n) => n.id === conn.source);
			const target = nodes.find((n) => n.id === conn.target);
			if (!source || !target || !isTargetable(target.type)) return;
			if (edgeExists(source.id, target.id)) {
				setEdgeError("connect: already connected");
				return;
			}
			const token =
				source.type === "input"
					? referenceToken("input", (source.data as InputData).name)
					: referenceToken(source.type as "call" | "format", source.id);
			const result = editor.connect(target.id, token);
			setEdgeError(result.ok ? null : `connect: ${result.error ?? "invalid connection"}`);
		},
		[nodes, edgeExists, editor],
	);

	// Edge selection changes apply locally so an edge can be selected as the
	// Delete target. `remove` changes are dropped here: the real removal goes
	// through onEdgesDelete + editor.disconnect (validated). Not applying the
	// optimistic remove avoids a flash when a disconnect is rejected.
	const onEdgesChange = useCallback((changes: EdgeChange[]) => {
		const keep = changes.filter((c) => c.type !== "remove");
		if (keep.length > 0) setEdges((es) => applyEdgeChanges(keep, es));
	}, []);

	// Delete-edge: derive the source ref (input name vs step id) and target
	// step for every deleted edge, then editor.disconnectMany removes them all
	// against one candidate draft and validates once. Reducing in one call
	// avoids the stale-closure bug of calling a single-edge disconnect in a
	// loop (each would read the same render's draft, keeping only the last).
	// On success the graph re-derivation drops the edges; on failure they stay
	// (we never applied the optimistic remove).
	const onEdgesDelete = useCallback(
		(deleted: Edge[]) => {
			const refs = deleted.flatMap((e) => {
				const source = nodes.find((n) => n.id === e.source);
				const target = nodes.find((n) => n.id === e.target);
				if (!source || !target) return [];
				const refKind: "input" | "call" | "format" =
					source.type === "input" ? "input" : (source.type as "call" | "format");
				const refName = source.type === "input" ? (source.data as InputData).name : source.id;
				return [{ targetStepId: target.id, refKind, refName }];
			});
			if (refs.length === 0) return;
			const result = editor.disconnectMany(refs);
			if (!result.ok) setEdgeError(`disconnect: ${result.error ?? "failed"}`);
			else if ((result.removed ?? 0) > 1) setEdgeError(`removed ${result.removed} references`);
			else setEdgeError(null);
		},
		[nodes, editor],
	);

	const openDiff = useCallback(() => {
		if (editor.canSave) setDiffOpen(true);
	}, [editor.canSave]);

	// Cmd/Ctrl+S opens the diff modal (the explicit-save-with-review flow),
	// not a direct write. Bound at the document level; re-binds when openDiff
	// changes so it always sees the current canSave gate.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
				e.preventDefault();
				openDiff();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openDiff]);

	const confirmSave = useCallback(async () => {
		const { ok } = await editor.save();
		if (ok) setDiffOpen(false);
		// On conflict/parse-error the modal closes too (the banner / error
		// surfaces the reason in the rail); only a transport error keeps it
		// open implicitly via saving=false + no state change. Close either way
		// to avoid a stuck modal; the rail carries the message.
		else setDiffOpen(false);
	}, [editor]);

	// Install reads the saved file, so it is gated on a clean, conflict-free,
	// parseable document. The reason is shown when the button is disabled.
	let installDisabledReason: string | null = null;
	if (editor.dirty) installDisabledReason = "Save your changes before installing.";
	else if (editor.previewPending) installDisabledReason = "Validating…";
	else if (editor.saving) installDisabledReason = "Saving…";
	else if (editor.conflict) installDisabledReason = "Resolve the file conflict first.";
	else if (editor.previewError) installDisabledReason = "Fix the validation error first.";
	const canInstall = installDisabledReason === null;

	// Enforcement gaps are agent-adapter-based (surface-independent), so this
	// reflects what install-into-claude-skill will hit regardless of the
	// selected validation surface.
	const permissionGaps = editor.graphModel.validation?.permissions.gaps ?? [];

	// Opening the modal clears any prior install error/conflict so a fresh
	// attempt starts clean (the gate above already blocks opening while dirty).
	const openInstall = useCallback(() => {
		setInstallError(null);
		setInstallConflict(false);
		setInstallOpen(true);
	}, []);

	// Confirm from the modal. On success the modal closes; a 409 closes it and
	// raises the conflict banner (the file drifted under us); a 422 keeps the
	// modal open with the error shown so the user can read and retry.
	const onInstallConfirm = useCallback(
		async (allowUnenforcedPermissions: boolean) => {
			const outcome = await installed.install(editor.hash, allowUnenforcedPermissions);
			if (outcome.kind === "installed") {
				setInstallOpen(false);
			} else if (outcome.kind === "conflict") {
				setInstallOpen(false);
				setInstallConflict(true);
			} else {
				setInstallError(outcome.error);
			}
		},
		[installed, editor.hash],
	);

	const selected = nodes.find((n) => n.id === selectedId) ?? null;
	const description = String(editor.draftSource.description ?? "");

	// Feed `selected: true` back into the nodes React Flow renders so the
	// .react-flow__node.selected class is applied. Without this, our
	// onSelectionChange only updates inspector state; the DOM never gets the
	// CSS hook for the inverted header + outer outline.
	// deletable: false so a node selected when Delete is pressed never enters
	// React Flow's element-delete path — only edges are deletable. selected is
	// fed back so the .selected CSS hook applies.
	const reactFlowNodes = useMemo(
		() => nodes.map((n) => ({ ...n, selected: n.id === selectedId, deletable: false })),
		[nodes, selectedId],
	);

	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">{initial.relPath}</span>
					{editor.dirty && (
						<span
							className="dirty-dot"
							role="img"
							title="unsaved changes"
							aria-label="unsaved changes"
						>
							●
						</span>
					)}
					<button
						type="button"
						className="btn-primary save-btn"
						onClick={openDiff}
						disabled={!editor.canSave}
					>
						Save
					</button>
					<button
						type="button"
						className="btn-secondary install-btn"
						onClick={openInstall}
						disabled={!canInstall}
						title={canInstall ? undefined : (installDisabledReason ?? undefined)}
					>
						Install
					</button>
					<button
						type="button"
						className="btn-secondary installed-btn"
						onClick={() => setDrawerOpen(true)}
					>
						Installed{installed.list.length > 0 ? ` (${installed.list.length})` : ""}
					</button>
					<button
						type="button"
						className="btn-secondary loops-btn"
						onClick={() => setLoopsOpen(true)}
					>
						Loops
						{loops.list.status === "ready" && loops.list.loops.length > 0
							? ` (${loops.list.loops.length})`
							: ""}
					</button>
					<span className="header-divider">·</span>
					<SurfaceSelector
						value={editor.surface}
						onChange={editor.changeSurface}
						disabled={editor.previewPending || editor.saving}
					/>
				</span>
			</header>
			<div className="split">
				<div className="canvas-wrap">
					<ReactFlow
						nodes={reactFlowNodes}
						edges={edges}
						nodeTypes={nodeTypes}
						onSelectionChange={onSelectionChange}
						onNodeClick={onNodeClick}
						onConnect={onConnect}
						onEdgesChange={onEdgesChange}
						onEdgesDelete={onEdgesDelete}
						isValidConnection={isValidConnection}
						proOptions={{ hideAttribution: true }}
						nodesDraggable={false}
						nodesConnectable={true}
						elementsSelectable
						// Single-element selection only: no shift-multi-select, no
						// drag-selection box. Keeps the delete path to one edge at a
						// time (disconnectMany still handles N defensively).
						multiSelectionKeyCode={null}
						selectionKeyCode={null}
						// Both keys delete a selected edge (v12's default is
						// Backspace only). Nodes are deletable:false, so only edges go.
						deleteKeyCode={["Backspace", "Delete"]}
						minZoom={0.4}
						maxZoom={2}
						// onPaneClick noop keeps selection sticky: clicking blank
						// canvas does not clear the inspector. Users build a mental
						// model around "the inspector reflects what I last looked
						// at"; default-clearing is friction.
						onPaneClick={() => {}}
					>
						<FitOnReady />
						<Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#C7BFAB" />
						<Controls showInteractive={false} />
					</ReactFlow>
				</div>
				<aside className="right-rail">
					{(editor.conflict || installConflict) && (
						<ConflictBanner onReload={() => window.location.reload()} />
					)}
					{edgeError && <div className="refetch-error">{edgeError}</div>}
					{editor.previewError && <div className="refetch-error">{editor.previewError}</div>}
					<ValidationPanel validation={editor.graphModel.validation} />
					<ManifestPanel description={description} onDescriptionChange={editor.setDescription} />
					<Inspector
						selected={selected}
						draftSource={editor.draftSource}
						onParticipantField={editor.setParticipantField}
						onStepField={editor.setStepField}
					/>
				</aside>
			</div>
			{diffOpen && (
				<DiffModal
					relPath={initial.relPath}
					before={editor.raw}
					after={canonicalize(editor.draftSource)}
					saving={editor.saving}
					onConfirm={confirmSave}
					onCancel={() => setDiffOpen(false)}
				/>
			)}
			{installOpen && (
				<InstallModal
					relPath={initial.relPath}
					gaps={permissionGaps}
					busy={installed.busy}
					error={installError}
					onConfirm={onInstallConfirm}
					onCancel={() => setInstallOpen(false)}
				/>
			)}
			{drawerOpen && (
				<InstalledDrawer
					list={installed.list}
					busy={installed.busy}
					error={installed.error}
					onUninstall={installed.uninstall}
					onClose={() => setDrawerOpen(false)}
				/>
			)}
			{loopsOpen && <LoopsDrawer loops={loops} onClose={() => setLoopsOpen(false)} />}
		</>
	);
}

function PickerMode({ state }: { state: PickerClientState }) {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">picker</span>
				</span>
			</header>
			<div className="message">
				<h2>Multiple chits in this directory.</h2>
				<p>
					Pick one to open. Click-to-open lands in a later sub-unit; for now, relaunch with an
					explicit path: <code>chit studio &lt;path&gt;</code>.
				</p>
				<ul className="picker-list">
					{state.candidates.map((c) => (
						<li key={c.docId} className={`picker-item picker-item--${c.status}`}>
							<code>{c.relPath}</code>
							<span className="picker-status">{c.status}</span>
						</li>
					))}
				</ul>
			</div>
		</>
	);
}

function ErrorMode({ state }: { state: OpenErrorClientState }) {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">parse error</span>
				</span>
			</header>
			<div className="message">
				<h2>
					Could not parse <code>{state.relPath}</code>.
				</h2>
				<pre className="parse-error">{state.parseError}</pre>
			</div>
		</>
	);
}

function EmptyMode() {
	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">studio</span>
				</span>
				<span className="header-right">
					<span className="path-label">no chit</span>
				</span>
			</header>
			<div className="message">
				<h2>No chit in this directory.</h2>
				<p>
					Launch with an explicit path: <code>chit studio &lt;path&gt;</code>, or run from a
					directory containing exactly one chit-shaped JSON file.
				</p>
			</div>
		</>
	);
}

export function App({ state }: { state: ClientState }) {
	if (state.mode === "open") return <OpenMode initial={state} />;
	if (state.mode === "open-error") return <ErrorMode state={state} />;
	if (state.mode === "picker") return <PickerMode state={state} />;
	return <EmptyMode />;
}
