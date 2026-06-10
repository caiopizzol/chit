// The Live Tower: Studio's primary screen. A calm control-tower read of what is
// alive across Chit right now, with the canonical mock's four visible parts: a
// top bar carrying the live identity and an at-a-glance count, a compact session
// rail (foreground + background groups), the selected run's detail with its
// agent blocks, and a small console of local activity. It consumes ONLY the GET
// /api/live snapshot via useLive; it never reads private state, streams model
// output, or carries run actions (apply/cancel/cleanup are a later slice). It is
// the page, not an overlay, so it polls while mounted and resets its read
// session on a reload rather than on an open/close toggle.

import { Fragment, useCallback, useState } from "react";
import type { LiveActivityRow } from "../server/types.ts";
import { cancelLiveRun } from "./api.ts";
import { ConfigPanel } from "./ConfigPanel.tsx";
import {
	activeRole,
	agentBlockViews,
	cancelAvailable,
	cancelMessage,
	cancelPending,
	concisePhase,
	detailAges,
	eventTail,
	flattenRows,
	formatAge,
	headPhaseElapsed,
	iterationLabel,
	liveBody,
	phaseTimeline,
	rowKey,
} from "./live.ts";
import { type LiveConsoleEntry, useLive } from "./useLive.ts";

function agentTone(agentId: string): "claude" | "codex" | "neutral" {
	const id = agentId.toLowerCase();
	if (id.includes("claude")) return "claude";
	if (id.includes("codex")) return "codex";
	return "neutral";
}

function rowSummary(row: LiveActivityRow): { dot: string; text: string } {
	const role = activeRole(row);
	if (row.source === "background" && row.display === "stale") {
		return { dot: "live-dot--stale", text: "stalled" };
	}
	if (role === "implementer")
		return { dot: "live-dot--claude live-dot--pulse", text: "implementing" };
	if (role === "reviewer") return { dot: "live-dot--codex live-dot--pulse", text: "reviewing" };
	if (role === "checks") return { dot: "live-dot--check live-dot--pulse", text: "checking" };
	return { dot: "live-dot--neutral", text: concisePhase(row) };
}

// The agent+adapter participants of a run, drawn as connected blocks. The
// active phase lights up the matching role, and that live block carries the
// current-phase elapsed, so the operator sees who is executing and for how long
// without reading a transcript.
function AgentBlocks({ row }: { row: LiveActivityRow }) {
	const views = agentBlockViews(row);
	if (views.length === 0) {
		return <p className="live-muted">No agent participants reported.</p>;
	}
	return (
		<div className="agent-blocks">
			{views.map((v, i) => (
				<Fragment key={v.role}>
					{i > 0 && (
						<span className="agent-connector" aria-hidden="true">
							→
						</span>
					)}
					<div
						className={`agent-block agent-block--${agentTone(v.agentId)}${
							v.live ? " agent-block--live" : ""
						}${v.warm ? " agent-block--warm" : ""}`}
					>
						<span className="agent-role">{v.role}</span>
						<span className="agent-id">{v.agentId}</span>
						<span className="agent-adapter">{v.adapter}</span>
						{v.phaseElapsed && <span className="agent-phase-elapsed">{v.phaseElapsed}</span>}
					</div>
				</Fragment>
			))}
		</div>
	);
}

// One row in the session rail: scope, concise phase, and elapsed age. The whole
// row is the select target.
function RailRow({
	row,
	selected,
	onSelect,
}: {
	row: LiveActivityRow;
	selected: boolean;
	onSelect: (key: string) => void;
}) {
	const summary = rowSummary(row);
	return (
		<button
			type="button"
			className={`live-row${selected ? " live-row--on" : ""}`}
			onClick={() => onSelect(rowKey(row))}
		>
			<span className="live-row-scope">{row.scope}</span>
			<span className="live-row-exec">
				<span className={`live-dot ${summary.dot}`} aria-hidden="true" />
				<span>{summary.text}</span>
				<span className="live-row-age">{formatAge(row.elapsedMs)}</span>
			</span>
		</button>
	);
}

function RailGroup({
	title,
	rows,
	selectedKey,
	onSelect,
}: {
	title: string;
	rows: LiveActivityRow[];
	selectedKey: string | null;
	onSelect: (key: string) => void;
}) {
	return (
		<section className="live-group">
			<h3 className="live-col-head">
				{title}
				{rows.length > 0 && <span className="live-count">{rows.length}</span>}
			</h3>
			{rows.length === 0 ? (
				<p className="live-group-empty">none</p>
			) : (
				rows.map((row) => (
					<RailRow
						key={rowKey(row)}
						row={row}
						selected={rowKey(row) === selectedKey}
						onSelect={onSelect}
					/>
				))
			)}
		</section>
	);
}

// The current iteration's phase timeline: a compact ordered strip of phase name
// plus elapsed, with the trailing active entry marked. Foreground rows only --
// rows without a structured timeline (background, older servers) render nothing.
function PhaseTimeline({ row }: { row: LiveActivityRow }) {
	const entries = phaseTimeline(row);
	if (entries.length === 0) return null;
	return (
		<ol className="live-phases">
			{entries.map((e) => (
				<li key={e.key} className={`live-phase${e.active ? " live-phase--active" : ""}`}>
					<span className="live-phase-name">{e.phase}</span>
					<span className="live-phase-age">{e.elapsed}</span>
				</li>
			))}
		</ol>
	);
}

// The selected run's recent-event tail: its last few runtime events as quiet
// one-liners (age + host-built safe label). A glance at "what is it doing right
// now", not a transcript panel -- rows without a tail render nothing.
function RecentActivity({ row }: { row: LiveActivityRow }) {
	const entries = eventTail(row);
	if (entries.length === 0) return null;
	return (
		<section className="live-events">
			<h4 className="live-events-head">recent activity</h4>
			<ol className="live-events-list">
				{entries.map((e) => (
					<li key={e.key} className="live-event">
						<span className="live-event-age">{e.age}</span>
						<span className="live-event-label">{e.label}</span>
					</li>
				))}
			</ol>
		</section>
	);
}

function TaskDisclosure({ task }: { task: string }) {
	return (
		<details className="live-detail-task">
			<summary>
				<span className="live-task-text">{task}</span>
				<span className="live-task-action live-task-open">full prompt</span>
				<span className="live-task-action live-task-close">close</span>
			</summary>
		</details>
	);
}

// The selected run's action strip: a client-side Copy run id always, plus a real
// Cancel only for background rows (cancelAvailable). Foreground rows are a
// cross-process mirror Studio does not control, so they get copy-only -- no fake
// cancel. Feedback is local and transient; a cancel re-polls the snapshot so the
// rail reflects the new phase without waiting out the poll interval. The parent
// remounts this via a row-keyed `key`, so the transient feedback/busy state
// resets when the selected run changes (no stale "cancel requested" on a new row).
function ActionStrip({ row, refresh }: { row: LiveActivityRow; refresh: () => void }) {
	const [msg, setMsg] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(row.runId);
			setMsg("run id copied");
		} catch {
			setMsg("copy unavailable");
		}
	}, [row.runId]);

	const cancel = useCallback(async () => {
		setBusy(true);
		setMsg("cancelling…");
		try {
			const outcome = await cancelLiveRun(row.runId, row.source);
			setMsg(cancelMessage(outcome));
		} catch {
			// cancelLiveRun returns the structured 4xx/5xx outcomes; it only throws on
			// a transport/network failure. Surface a compact note rather than leaving
			// the button stuck on "cancelling…".
			setMsg("cancel failed · network");
		} finally {
			// Always clear busy and re-read the snapshot, success or failure: the row
			// shows its new phase (cancelling) or drops out, and a failed attempt
			// re-syncs against the true state. Selection is keyed by runId, so it
			// stays put if the row survives.
			setBusy(false);
			refresh();
		}
	}, [row.runId, row.source, refresh]);

	const pending = cancelPending(row);
	return (
		<div className="live-actions">
			<button type="button" className="live-action" onClick={copy}>
				copy run id
			</button>
			{cancelAvailable(row) && (
				<button
					type="button"
					className="live-action live-action--cancel"
					disabled={busy || pending}
					onClick={cancel}
				>
					{pending ? "cancelling…" : "cancel run"}
				</button>
			)}
			{msg && <span className="live-action-msg">{msg}</span>}
		</div>
	);
}

function Detail({ row, refresh }: { row: LiveActivityRow | null; refresh: () => void }) {
	if (!row) {
		return <p className="live-muted live-detail-empty">Select a live run to inspect it.</p>;
	}
	// Phase timing normally rides on the live agent block; the head only shows it
	// when no block claims the phase, so it appears exactly once either way.
	const phaseAge = headPhaseElapsed(row);
	const iteration = iterationLabel(row);
	return (
		<div className="live-detail">
			<div className="live-detail-head">
				<span className={`live-source live-source--${row.source}`}>{row.source}</span>
				<span className="live-detail-phase">{concisePhase(row)}</span>
				{phaseAge && <span className="live-detail-phase-age">{phaseAge}</span>}
				{iteration && <span className="live-detail-iter">{iteration}</span>}
			</div>
			<ActionStrip key={rowKey(row)} row={row} refresh={refresh} />
			<p className="live-detail-scope">{row.scope}</p>
			{row.task && <TaskDisclosure task={row.taskFull ?? row.task} />}
			<div className="live-ages">
				{detailAges(row).map(([label, ms]) => (
					<div className="live-age-cell" key={label}>
						<span className="live-age-label">{label}</span>
						<span className="live-age-val">{formatAge(ms)}</span>
					</div>
				))}
			</div>
			<PhaseTimeline row={row} />
			<AgentBlocks row={row} />
			<RecentActivity row={row} />
			{row.worktreePath && (
				<p className="live-worktree">
					<span className="live-worktree-label">worktree</span>
					<code>{row.worktreePath}</code>
				</p>
			)}
		</div>
	);
}

function consoleLineClass(entry: LiveConsoleEntry): string {
	const text = entry.text.toLowerCase();
	if (text.includes("implement")) return "live-console-line--claude";
	if (text.includes("review")) return "live-console-line--codex";
	if (text.includes("check") || text.includes("passed") || text.includes("converged")) {
		return "live-console-line--pass";
	}
	if (text.includes("failed") || text.includes("blocked") || text.includes("stale")) {
		return "live-console-line--fail";
	}
	return `live-console-line--${entry.source}`;
}

function Console({ log }: { log: LiveConsoleEntry[] }) {
	if (log.length === 0) {
		return <p className="live-muted live-console-empty">No activity yet.</p>;
	}
	return (
		<ol className="live-console">
			{log.map((e) => (
				<li key={e.id} className={`live-console-line ${consoleLineClass(e)}`}>
					<span className="live-console-time">{e.time}</span>
					<span className="live-console-run">{e.runId}</span>
					<span className="live-console-text">{e.text}</span>
				</li>
			))}
		</ol>
	);
}

export function LiveTower() {
	const live = useLive();
	const { activity, status, error, log, selectedKey, selected, select, refresh } = live;
	// The effective-config drawer is an on-demand overlay so the default view
	// stays the live monitor; mounting on open is what makes each open re-fetch
	// (the server re-reads disk per request).
	const [configOpen, setConfigOpen] = useState(false);
	const body = liveBody(activity, log.length);
	const liveCount = flattenRows(activity).length;
	const selectedLog = selected
		? log.filter((e) => `${e.source}:${e.runId}` === rowKey(selected))
		: log;

	return (
		<>
			<header className="app">
				<span className="wordmark">chit.live</span>
				<span className="header-right">
					<span className="live-total">
						{liveCount} {liveCount === 1 ? "run" : "runs"} live
					</span>
					<span className="live-legend">
						<span className="live-legend-item">
							<span className="live-dot live-dot--claude" aria-hidden="true" />
							Claude
						</span>
						<span className="live-legend-item">
							<span className="live-dot live-dot--codex" aria-hidden="true" />
							Codex
						</span>
					</span>
					{/* A poll error is a passing condition, not a wall: keep the last
					    snapshot visible and just note that we are retrying. */}
					{error && (
						<span className="live-reconnect" title={error}>
							reconnecting…
						</span>
					)}
					<button
						type="button"
						className="btn-secondary config-btn"
						onClick={() => setConfigOpen(true)}
					>
						config
					</button>
				</span>
			</header>
			{configOpen && <ConfigPanel onClose={() => setConfigOpen(false)} />}
			{status === "loading" ? (
				<div className="live-main live-body">
					<p className="live-muted">Loading live activity…</p>
				</div>
			) : body === "empty" ? (
				<div className="live-main live-body">
					<div className="live-empty">
						<p className="live-empty-head">Nothing is live right now.</p>
						<p className="live-empty-sub">
							Foreground loops and background jobs appear here while they run. No chit manifest is
							needed to watch.
						</p>
					</div>
				</div>
			) : body === "empty-with-console" ? (
				// The rail has cleared but the console still holds the run's last
				// transitions. Keep them visible below a calm header so the final
				// "disappeared" line is not hidden the instant the row exits.
				<div className="live-main live-body live-body--cleared">
					<div className="live-cleared">
						<p className="live-empty-head">No live runs right now.</p>
						<p className="live-empty-sub">
							The last run has ended. Recent activity stays below until you reload.
						</p>
						<section className="live-cleared-console">
							<h3 className="live-col-head">Console</h3>
							<Console log={log} />
						</section>
					</div>
				</div>
			) : (
				<div className="live-main live-grid">
					<aside className="live-rail">
						<h2 className="live-fleet-head">your sessions · live</h2>
						<RailGroup
							title="Foreground"
							rows={activity.foreground}
							selectedKey={selectedKey}
							onSelect={select}
						/>
						<RailGroup
							title="Background"
							rows={activity.background}
							selectedKey={selectedKey}
							onSelect={select}
						/>
					</aside>
					<main className="live-panel">
						<section className="live-center">
							<Detail row={selected} refresh={refresh} />
						</section>
						<section className="live-console-col">
							<h3 className="live-col-head live-col-head--console">Console</h3>
							<Console log={selectedLog} />
						</section>
					</main>
				</div>
			)}
		</>
	);
}
