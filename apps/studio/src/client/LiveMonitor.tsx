// The live monitor overlay: a calm control-tower read of what is alive across
// Chit right now. Three regions per the canonical mock -- a compact session
// rail (foreground + background groups), the selected run's detail with its
// agent blocks, and a small console of local activity. It consumes ONLY the
// GET /api/live snapshot via useLive; it never reads private state, streams
// model output, or carries run actions (apply/cancel/cleanup are a later
// slice). A full-screen takeover so the three columns breathe, opened from the
// header and closed with × or Escape; the editor underneath is untouched.

import { Fragment, useEffect } from "react";
import type { LiveActivityRow, LiveParticipant } from "../server/types.ts";
import { formatAge, liveBody, phaseLabel, rowKey } from "./live.ts";
import type { LiveConsoleEntry, LiveState } from "./useLive.ts";

// The agent+adapter participants of a run, drawn as connected blocks -- the
// visual "who ran" the mock leads with. The connector is presentational; the
// pairs are an unordered map, so this reads as "these agents are in this run",
// not a strict pipeline.
function AgentBlocks({ participants }: { participants?: Record<string, LiveParticipant> }) {
	const entries = participants ? Object.entries(participants) : [];
	if (entries.length === 0) {
		return <p className="live-muted">No agent participants reported.</p>;
	}
	return (
		<div className="agent-blocks">
			{entries.map(([role, p], i) => (
				<Fragment key={role}>
					{i > 0 && (
						<span className="agent-connector" aria-hidden="true">
							→
						</span>
					)}
					<div className="agent-block">
						<span className="agent-role">{role}</span>
						<span className="agent-id">{p.agentId}</span>
						<span className="agent-adapter">{p.adapter}</span>
					</div>
				</Fragment>
			))}
		</div>
	);
}

// One row in the session rail: phase line, elapsed age, scope, and the compact
// status line. The whole row is the select target.
function RailRow({
	row,
	selected,
	onSelect,
}: {
	row: LiveActivityRow;
	selected: boolean;
	onSelect: (key: string) => void;
}) {
	return (
		<button
			type="button"
			className={`live-row${selected ? " live-row--on" : ""}`}
			onClick={() => onSelect(rowKey(row))}
		>
			<span className="live-row-top">
				<span className="live-row-phase">{phaseLabel(row)}</span>
				<span className="live-row-age">{formatAge(row.elapsedMs)}</span>
			</span>
			<span className="live-row-scope">{row.scope}</span>
			<span className="live-row-status">{row.statusLine}</span>
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

// Ages shown for the selected run. Foreground rows report last-activity age;
// background rows report a worker heartbeat age. The other two (elapsed, phase
// elapsed) are shared.
function detailAges(row: LiveActivityRow): Array<[string, number | undefined]> {
	if (row.source === "foreground") {
		return [
			["elapsed", row.elapsedMs],
			["phase", row.phaseElapsedMs],
			["last activity", row.lastActivityAgeMs],
		];
	}
	return [
		["elapsed", row.elapsedMs],
		["phase", row.phaseElapsedMs],
		["heartbeat", row.lastHeartbeatAgeMs],
	];
}

function Detail({ row }: { row: LiveActivityRow | null }) {
	if (!row) {
		return <p className="live-muted live-detail-empty">Select a live run to inspect it.</p>;
	}
	return (
		<div className="live-detail">
			<div className="live-detail-head">
				<span className={`live-source live-source--${row.source}`}>{row.source}</span>
				<span className="live-detail-phase">{phaseLabel(row)}</span>
			</div>
			<p className="live-detail-scope">{row.scope}</p>
			{row.task && <p className="live-detail-task">{row.task}</p>}
			<p className="live-detail-status">{row.statusLine}</p>
			<div className="live-ages">
				{detailAges(row).map(([label, ms]) => (
					<div className="live-age-cell" key={label}>
						<span className="live-age-label">{label}</span>
						<span className="live-age-val">{formatAge(ms)}</span>
					</div>
				))}
			</div>
			<AgentBlocks participants={row.participants} />
			{row.worktreePath && (
				<p className="live-worktree">
					<span className="live-worktree-label">worktree</span>
					<code>{row.worktreePath}</code>
				</p>
			)}
		</div>
	);
}

function Console({ log }: { log: LiveConsoleEntry[] }) {
	if (log.length === 0) {
		return <p className="live-muted live-console-empty">No activity yet.</p>;
	}
	return (
		<ol className="live-console">
			{log.map((e) => (
				<li key={e.id} className="live-console-line">
					<span className="live-console-time">{e.time}</span>
					<span className="live-console-run">{e.runId}</span>
					<span className="live-console-text">{e.text}</span>
				</li>
			))}
		</ol>
	);
}

export function LiveMonitor({ live, onClose }: { live: LiveState; onClose: () => void }) {
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const { activity, status, error, log, selectedKey, selected, select } = live;
	const body = liveBody(activity, log.length);

	return (
		<div className="live-overlay">
			<header className="live-head">
				<h2>Live</h2>
				<span className="live-head-right">
					{/* A poll error is a passing condition, not a wall: keep the last
					    snapshot visible and just note that we are retrying. */}
					{error && (
						<span className="live-reconnect" title={error}>
							reconnecting…
						</span>
					)}
					<button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
						×
					</button>
				</span>
			</header>
			{status === "loading" ? (
				<div className="live-body">
					<p className="live-muted">Loading live activity…</p>
				</div>
			) : body === "empty" ? (
				<div className="live-body">
					<div className="live-empty">
						<p className="live-empty-head">Nothing is live right now.</p>
						<p className="live-empty-sub">
							Foreground loops and background jobs appear here while they run.
						</p>
					</div>
				</div>
			) : body === "empty-with-console" ? (
				// The rail has cleared but the console still holds the run's last
				// transitions. Keep them visible below a calm header so the final
				// "disappeared" line is not hidden the instant the row exits.
				<div className="live-body live-body--cleared">
					<div className="live-cleared">
						<p className="live-empty-head">No live runs right now.</p>
						<p className="live-empty-sub">
							The last run has ended. Recent activity stays below until you reopen Live.
						</p>
						<section className="live-cleared-console">
							<h3 className="live-col-head">Console</h3>
							<Console log={log} />
						</section>
					</div>
				</div>
			) : (
				<div className="live-grid">
					<aside className="live-rail">
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
					<main className="live-center">
						<Detail row={selected} />
					</main>
					<aside className="live-console-col">
						<h3 className="live-col-head">Console</h3>
						<Console log={log} />
					</aside>
				</div>
			)}
		</div>
	);
}
