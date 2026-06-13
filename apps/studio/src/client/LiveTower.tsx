// The Live Tower: Studio's primary screen. A calm control-tower read of what is
// alive across Chit right now, with the canonical mock's four visible parts: a
// top bar carrying the live identity and an at-a-glance count, a compact session
// rail (foreground + background groups), the selected run's detail with its
// agent blocks, and a small console of local activity. It consumes the GET
// /api/live snapshot via useLive plus the bounded cancel action for background
// runs; it never reads private state, streams model output, applies changes, or
// cleans up worktrees. It is the page, not an overlay, so it polls while mounted and resets its read
// session on a reload rather than on an open/close toggle.

import { useCallback, useEffect, useState } from "react";
import type { DeclaredRoutine, LiveActivityRow } from "../server/types.ts";
import { cancelLiveRun, fetchRoutines } from "./api.ts";
import { ConfigPanel } from "./ConfigPanel.tsx";
import { formatTimeout, recipeMeta } from "./configView.ts";
import {
	activeRole,
	agentBlockViews,
	type BlockFeedRole,
	blockFeed,
	cancelAvailable,
	cancelMessage,
	cancelPending,
	concisePhase,
	flattenRows,
	formatAge,
	headPhaseElapsed,
	iterationLabel,
	phaseTimeline,
	rowKey,
	shortDigest,
} from "./live.ts";
import { routineCanvas, routineKey, routineTicker, towerBody } from "./routines.ts";
import { type LiveConsoleEntry, useLive } from "./useLive.ts";

type LoopRole = string;

interface LoopBlock {
	role: LoopRole;
	label: string;
	present: boolean;
	agentId?: string;
	detail?: string;
	live?: boolean;
	warm?: boolean;
}

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

function isBlockFeedRole(role: LoopRole): role is BlockFeedRole {
	return role === "implementer" || role === "reviewer" || role === "checks" || role === "you";
}

function blockFeedLineClass(
	entry: ReturnType<typeof blockFeed>[number],
	role: BlockFeedRole,
): string {
	if (entry.kind === "step.failed") return "block-feed-line--fail";
	if (role === "implementer") return "block-feed-line--implementer";
	if (role === "reviewer") return "block-feed-line--reviewer";
	return "block-feed-line--checks";
}

function LiveBlockFeed({
	row,
	selectedBlock,
}: {
	row: LiveActivityRow | null;
	selectedBlock: LoopRole;
}) {
	const feedRole = isBlockFeedRole(selectedBlock) ? selectedBlock : "implementer";
	const entries = row ? blockFeed(row, feedRole) : [];
	return (
		<section className="block-feed">
			<div className="block-feed-head">
				<span>feed</span>
				<span className="block-feed-role">{feedRole}</span>
				<span>refreshed</span>
			</div>
			{entries.length === 0 ? (
				<p className="block-feed-empty">No events for this block.</p>
			) : (
				<ol className="block-feed-list">
					{entries.map((e) => (
						<li
							key={e.key}
							className={`block-feed-line ${blockFeedLineClass(e, feedRole)}${
								e.active ? " block-feed-line--active" : ""
							}`}
						>
							<span className="block-feed-time">{e.time}</span>
							<span className="block-feed-kind">{e.kind}</span>
							<span className="block-feed-label">{e.label}</span>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function LiveWorkspace({
	row,
	selectedBlock,
	onSelectBlock,
}: {
	row: LiveActivityRow | null;
	selectedBlock: LoopRole;
	onSelectBlock: (role: LoopRole) => void;
}) {
	return (
		<div className="studio-workspace">
			{row ? (
				<LoopCanvas
					blocks={liveLoopBlocks(row)}
					selectedBlock={selectedBlock}
					onSelectBlock={onSelectBlock}
				/>
			) : (
				<div className="studio-canvas">
					<p className="live-muted">Select a live run to inspect it.</p>
				</div>
			)}
			<LiveBlockFeed row={row} selectedBlock={selectedBlock} />
		</div>
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

function RoutineRailRow({
	routine,
	selected,
	onSelect,
}: {
	routine: DeclaredRoutine;
	selected: boolean;
	onSelect: (key: string) => void;
}) {
	return (
		<button
			type="button"
			className={`live-row${selected ? " live-row--on" : ""}`}
			onClick={() => onSelect(routineKey(routine))}
		>
			<span className="live-row-scope">{routine.id}</span>
			<span className="live-row-exec">
				<span className="routine-origin">{routine.origin}</span>
				<span>{routine.mode}</span>
				{routine.error && <span className="live-row-age">unresolved</span>}
			</span>
		</button>
	);
}

function loopBlockWho(block: LoopBlock): string {
	if (block.role === "checks" && block.detail?.includes(" required / ")) {
		const count = block.detail.split(" ", 1)[0];
		return `chit · ${count}`;
	}
	return block.agentId ?? "unknown";
}

function LoopCanvas({
	blocks,
	selectedBlock,
	onSelectBlock,
	rest = false,
	loop = true,
}: {
	blocks: LoopBlock[];
	selectedBlock: LoopRole;
	onSelectBlock: (role: LoopRole) => void;
	rest?: boolean;
	loop?: boolean;
}) {
	const nodes = blocks.filter((b) => b.role !== "you");
	return (
		<div className={`studio-canvas${rest ? " studio-canvas--rest" : ""}`}>
			<div className="loopwrap">
				{nodes.map((block, i) => (
					<div className="loop-node" key={block.role}>
						{i > 0 && <span className="awire" aria-hidden="true" />}
						<button
							type="button"
							className={`loop-block loop-block--${agentTone(block.agentId ?? "")}${
								block.live ? " loop-block--live" : ""
							}${block.warm ? " loop-block--warm" : ""}${
								block.present ? "" : " loop-block--idle"
							}${selectedBlock === block.role ? " loop-block--selected" : ""}`}
							onClick={() => onSelectBlock(block.role)}
						>
							<span className="loop-role">{block.label}</span>
							<span className="loop-who">
								<span className={`loop-ring loop-ring--${agentTone(block.agentId ?? "")}`} />
								{loopBlockWho(block)}
							</span>
							{block.detail && <span className="loop-sub">{block.detail}</span>}
						</button>
					</div>
				))}
				<span className="awire" aria-hidden="true" />
				<button
					type="button"
					className={`yougate${selectedBlock === "you" ? " yougate--selected" : ""}`}
					onClick={() => onSelectBlock("you")}
				>
					<span className="yougate-diamond" aria-hidden="true" />
					<span className="label">you</span>
				</button>
				{loop && <span className="loopback" aria-hidden="true" />}
			</div>
		</div>
	);
}

function liveLoopBlocks(row: LiveActivityRow): LoopBlock[] {
	const agents = agentBlockViews(row);
	const find = (role: LoopRole) =>
		agents.find((a) => {
			const key = a.role.toLowerCase();
			if (role === "implementer") return key.includes("impl") || key.includes("plan");
			if (role === "reviewer") return key.includes("rev");
			if (role === "checks") return key.includes("check");
			return false;
		});
	const block = (role: Exclude<LoopRole, "you">): LoopBlock => {
		const agent = find(role);
		if (!agent) {
			return { role, label: role, present: false, detail: "not reported" };
		}
		const detail = [agent.model, agent.phaseElapsed ?? agent.adapter].filter(Boolean).join(" / ");
		return {
			role,
			label: role,
			present: true,
			agentId: agent.agentId,
			detail,
			live: agent.live,
			warm: agent.warm,
		};
	};
	return [
		block("implementer"),
		block("reviewer"),
		block("checks"),
		{
			role: "you",
			label: "you",
			present: true,
			agentId: "operator",
			detail: "approves and monitors",
		},
	];
}

function selectedRoutineBlock(routine: DeclaredRoutine, selectedBlock: LoopRole): LoopBlock {
	return (
		routineCanvas(routine).find((b) => b.role === selectedBlock) ?? {
			role: selectedBlock,
			label: selectedBlock,
			present: false,
			detail: "not declared",
		}
	);
}

function RoutineInspector({
	routine,
	selectedBlock,
}: {
	routine: DeclaredRoutine;
	selectedBlock: LoopRole;
}) {
	const manifest = routine.manifest;
	const block = selectedRoutineBlock(routine, selectedBlock);
	const selectedStep = manifest?.steps.find((step) => step.id === selectedBlock);
	return (
		<aside className="studio-inspector">
			<div className="panel-head">
				<span className="panel-title">{block.label}</span>
				<span className="panel-state">declared</span>
			</div>
			<dl className="facts">
				<dt>agent</dt>
				<dd>{block.agentId ?? "unknown"}</dd>
				<dt>can</dt>
				<dd>{block.detail ?? "not declared"}</dd>
				{selectedStep !== undefined && (
					<>
						<dt>step</dt>
						<dd>{selectedStep.kind}</dd>
					</>
				)}
				<dt>recipe</dt>
				<dd>{routine.id}</dd>
				<dt>layer</dt>
				<dd>{routine.origin}</dd>
				{routine.maxIterations !== undefined && (
					<>
						<dt>iters</dt>
						<dd>{routine.maxIterations}</dd>
					</>
				)}
				{routine.callTimeoutMs !== undefined && (
					<>
						<dt>timeout</dt>
						<dd>{formatTimeout(routine.callTimeoutMs)}</dd>
					</>
				)}
			</dl>
			<span className="label">declared in</span>
			<p className="panel-src">
				recipe <b>{routine.id}</b>
				<br />
				manifest <b>{routine.manifestPath}</b>
				{manifest?.manifestDigest && (
					<>
						<br />
						sha <b title={manifest.manifestDigest}>{shortDigest(manifest.manifestDigest)}</b>
					</>
				)}
			</p>
			{routine.error && <p className="config-error">{routine.error}</p>}
			{manifest && selectedBlock === "checks" && manifest.requiredChecks.length > 0 && (
				<ul className="config-list panel-checks">
					{manifest.requiredChecks.map((check) => (
						<li key={check.name ?? check.command} className="config-item">
							<code className="config-id">{check.name ?? "check"}</code>
							<p className="config-meta">
								{[check.command, ...check.args].join(" ")}
								{check.timeoutMs !== undefined && ` / ${formatTimeout(check.timeoutMs)}`}
							</p>
						</li>
					))}
				</ul>
			)}
		</aside>
	);
}

function LiveInspector({
	row,
	selectedBlock,
	refresh,
}: {
	row: LiveActivityRow | null;
	selectedBlock: LoopRole;
	refresh: () => void;
}) {
	if (!row) {
		return (
			<aside className="studio-inspector">
				<p className="live-muted">Select a live run.</p>
			</aside>
		);
	}
	const phaseAge = headPhaseElapsed(row);
	const iteration = iterationLabel(row);
	return (
		<aside className="studio-inspector">
			<div className="panel-head">
				<span className="panel-title">{selectedBlock}</span>
				<span className="panel-state panel-state--live">{concisePhase(row)}</span>
			</div>
			<dl className="facts">
				<dt>scope</dt>
				<dd>{row.scope}</dd>
				<dt>source</dt>
				<dd>{row.source}</dd>
				{iteration && (
					<>
						<dt>iter</dt>
						<dd>{iteration}</dd>
					</>
				)}
				{phaseAge && (
					<>
						<dt>phase</dt>
						<dd>{phaseAge}</dd>
					</>
				)}
				{row.elapsedMs !== undefined && (
					<>
						<dt>elapsed</dt>
						<dd>{formatAge(row.elapsedMs)}</dd>
					</>
				)}
			</dl>
			<ActionStrip key={rowKey(row)} row={row} refresh={refresh} />
			{row.task && <TaskDisclosure task={row.taskFull ?? row.task} />}
			<PhaseTimeline row={row} />
			{row.worktreePath && (
				<p className="live-worktree">
					<span className="live-worktree-label">worktree</span>
					<code>{row.worktreePath}</code>
				</p>
			)}
		</aside>
	);
}

function StageHeader({
	routine,
	row,
}: {
	routine: DeclaredRoutine | null;
	row: LiveActivityRow | null;
}) {
	if (routine) {
		return (
			<div className="studio-stage-head">
				<span className="stage-title">{routine.id}</span>
				<span className="stage-config">{recipeMeta(routine)}</span>
				<span className="stage-state">at rest</span>
			</div>
		);
	}
	return (
		<div className="studio-stage-head">
			<span className="stage-title">{row?.scope ?? "live"}</span>
			<span className="stage-config">{row?.statusLine ?? "no selected run"}</span>
			<span className="stage-state stage-state--live">{row ? concisePhase(row) : "idle"}</span>
		</div>
	);
}

function BottomTicker({
	routine,
	row,
	log,
}: {
	routine: DeclaredRoutine | null;
	row: LiveActivityRow | null;
	log: LiveConsoleEntry[];
}) {
	if (routine) {
		const ticker = routineTicker(routine);
		return (
			<div className="rest-ticker">
				<span className="ticker-key">{ticker.key}</span>
				<span>{ticker.text}</span>
				<span className="ticker-tail">{ticker.tail}</span>
			</div>
		);
	}
	const latest = log[log.length - 1];
	return (
		<div className="ticker">
			<div className="ticker-line">
				<span className="ticker-time">{latest?.time ?? "--:--"}</span>
				<span className="ticker-glyph" aria-hidden="true">
					•
				</span>
				<span className="ticker-text">{latest?.text ?? row?.statusLine ?? "No activity yet."}</span>
			</div>
			<span className="ticker-hint">console</span>
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
	const [routines, setRoutines] = useState<DeclaredRoutine[]>([]);
	const [routineLoadState, setRoutineLoadState] = useState<
		"loading" | "ready" | "unavailable" | "error"
	>("loading");
	const [routineError, setRoutineError] = useState<string | null>(null);
	const [routineSel, setRoutineSel] = useState<string | null>(null);
	const [selectedBlock, setSelectedBlock] = useState<LoopRole>("implementer");

	useEffect(() => {
		let alive = true;
		fetchRoutines()
			.then((outcome) => {
				if (!alive) return;
				if (outcome.kind === "ok") {
					setRoutines(outcome.routines.routines);
					setRoutineLoadState("ready");
					setRoutineError(null);
				} else if (outcome.kind === "unavailable") {
					setRoutineLoadState("unavailable");
					setRoutineError(null);
				} else {
					setRoutineLoadState("error");
					setRoutineError(outcome.error);
				}
			})
			.catch((e) => {
				if (!alive) return;
				setRoutineLoadState("error");
				setRoutineError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, []);

	const liveCount = flattenRows(activity).length;
	const body = towerBody(activity, routines.length, log.length);
	const activeRoutine =
		routineSel !== null
			? (routines.find((r) => routineKey(r) === routineSel) ?? null)
			: liveCount === 0
				? (routines[0] ?? null)
				: null;
	useEffect(() => {
		if (activeRoutine) {
			const blocks = routineCanvas(activeRoutine);
			if (!blocks.some((b) => b.role === selectedBlock)) {
				setSelectedBlock(blocks[0]?.role ?? "you");
			}
			return;
		}
		if (!["implementer", "reviewer", "checks", "you"].includes(selectedBlock)) {
			setSelectedBlock("implementer");
		}
	}, [activeRoutine, selectedBlock]);
	const selectLiveRow = useCallback(
		(key: string) => {
			setRoutineSel(null);
			select(key);
		},
		[select],
	);
	const railSelectedKey = activeRoutine ? null : selectedKey;
	const selectedLog =
		!activeRoutine && selected
			? log.filter((e) => `${e.source}:${e.runId}` === rowKey(selected))
			: log;
	const routineEmpty =
		routineLoadState === "loading"
			? "loading"
			: routineLoadState === "unavailable"
				? "not available"
				: routineLoadState === "error"
					? "routines unavailable"
					: "none declared";

	return (
		<>
			<header className="app">
				<span className="wordmark">
					chit <span className="light">· studio</span>
				</span>
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
						<h2 className="live-fleet-head">running</h2>
						<RailGroup
							title="Foreground"
							rows={activity.foreground}
							selectedKey={railSelectedKey}
							onSelect={selectLiveRow}
						/>
						<RailGroup
							title="Background"
							rows={activity.background}
							selectedKey={railSelectedKey}
							onSelect={selectLiveRow}
						/>
						<section className="live-group">
							<h3 className="live-col-head">
								this folder
								{routines.length > 0 && <span className="live-count">{routines.length}</span>}
							</h3>
							{routines.length === 0 ? (
								<p className="live-group-empty" title={routineError ?? undefined}>
									{routineEmpty}
								</p>
							) : (
								routines.map((routine) => (
									<RoutineRailRow
										key={routine.id}
										routine={routine}
										selected={activeRoutine?.id === routine.id}
										onSelect={setRoutineSel}
									/>
								))
							)}
						</section>
					</aside>
					<main className="live-panel">
						<StageHeader routine={activeRoutine} row={selected} />
						<section className={`studio-body${activeRoutine ? " studio-body--rest" : ""}`}>
							{activeRoutine ? (
								<>
									<LoopCanvas
										blocks={routineCanvas(activeRoutine)}
										selectedBlock={selectedBlock}
										onSelectBlock={setSelectedBlock}
										rest
										loop={activeRoutine.mode === "converge"}
									/>
									<RoutineInspector routine={activeRoutine} selectedBlock={selectedBlock} />
								</>
							) : (
								<>
									<LiveWorkspace
										row={selected}
										selectedBlock={selectedBlock}
										onSelectBlock={setSelectedBlock}
									/>
									<LiveInspector row={selected} selectedBlock={selectedBlock} refresh={refresh} />
								</>
							)}
						</section>
						<BottomTicker routine={activeRoutine} row={selected} log={selectedLog} />
					</main>
				</div>
			)}
		</>
	);
}
