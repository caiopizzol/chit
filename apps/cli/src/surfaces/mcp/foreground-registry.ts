// A small LOCAL registry of in-flight FOREGROUND loop activity, so another live
// Chit server (or a Studio process) can see what an in-chat foreground run is
// doing. Background jobs already have durable records (JobStore); foreground loop
// activity otherwise lives only in the supervising MCP process memory, which a
// second process cannot read. This is that bridge -- a compact, cross-process
// snapshot per active foreground iteration, written while the iteration is in
// flight and removed when it settles.
//
// Lifetime mirrors the in-memory activity snapshot (ConvergeSession.activity): a
// file appears when an iteration starts, updates on each phase transition (and on
// cancel), and is removed when the iteration settles. A foreground loop that is
// merely open between iterations has no activity and so no file -- the registry is
// about LIVE work, not idle sessions.
//
// Durability model, mirroring JobStore:
//   - Atomic writes (temp + rename), so a concurrent reader sees the old OR new
//     JSON, never a partial file.
//   - Liveness is judged at READ time, never trusted from the file alone, so a
//     crashed process or a stale snapshot does not look healthy forever. We do NOT
//     assume a cleanup sweep ever runs: a snapshot is live only when its writer's
//     pid is still alive AND its updatedAt is recent. pidAlive is the primary
//     signal (it catches a dead process at once); the updatedAt window is the
//     secondary guard against PID reuse (a reused pid belongs to an unrelated
//     process that never refreshes THIS snapshot).
//   - list() is side-effect-free: it never unlinks, so status assembly stays a pure
//     read. The one cleanup is an explicit, opportunistic dead-pid prune (pruneDead):
//     a foreground run id is a UUID, so a server killed mid-iteration leaves a
//     dead-pid file that no later run ever overwrites; list() would filter it forever
//     but never remove it. pruneDead unlinks ONLY snapshots whose writer pid is gone
//     (unambiguously safe -- the writer is dead). Stale-but-pid-alive files are left
//     to read-time filtering: the stale window is the PID-reuse guard, not a delete
//     trigger. Callers run pruneDead best-effort (e.g. the Studio live read), so a
//     prune failure never affects the snapshot it returns.
//
// Snapshots are intentionally concise and safe: ids, scope/task summaries, the
// repo key, a managed worktree path when present, the current iteration/phase,
// the run's iteration budget (maxIterations) and per-call timeout (callTimeoutMs,
// counters/numbers only), timestamps to derive elapsed/phase/last-activity, the
// current iteration's completed-phase timeline (phase names + timestamps only),
// the executing participants (agent + adapter only), and a compact statusLine.
// The optional taskFull is the user-authored task for Studio's explicit prompt
// disclosure. Snapshots NEVER carry model outputs, review prose, config/env
// values, or audit blobs.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../../jobs/health.ts";
import { repoKey as repoKeyOf } from "../../loops/location.ts";
import type { ConvergeSession } from "./converge-engine.ts";

// The phases a foreground iteration moves through. "starting" is the brief spin-up
// before the first step's trace event (the in-memory snapshot's phase is still
// undefined there); the rest mirror ConvergeSession's LoopPhase exactly, so this
// surface shares its vocabulary with the in-memory activity view and the
// background JobPhase where they overlap.
export type ForegroundPhase =
	| "starting"
	| "implementing"
	| "reviewing"
	| "running required checks"
	| "cancelling";

const FOREGROUND_PHASES: ReadonlySet<string> = new Set([
	"starting",
	"implementing",
	"reviewing",
	"running required checks",
	"cancelling",
]);

// A runId becomes a filename, so constrain it: no separators, traversal, dotfiles.
// Same rule as JobStore's SAFE_RUN_ID and the loop-log slug.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// How long a foreground snapshot may sit without an update before a reader treats
// it as stale, EVEN if its pid still resolves. While an iteration is in flight its
// supervising server refreshes the snapshot on a periodic heartbeat (see
// FOREGROUND_HEARTBEAT_MS), so updatedAt stays fresh even through a single long
// adapter phase (call_timeout_ms can push one phase well past the 15 minute
// default). A healthy run therefore heartbeats several times inside this window,
// while a crashed/wedged process stops refreshing and ages out. pidAlive is the
// other half of liveness: it catches an exited process at once and guards PID reuse
// (a reused-but-unrelated pid never refreshes THIS snapshot). Kept tight so a dead
// run does not look healthy for long.
export const FOREGROUND_STALE_AFTER_MS = 60_000;

// How often the supervising server refreshes an in-flight iteration's snapshot, so
// the stale window above stays satisfied through a long phase. Comfortably smaller
// than the window (several beats per window), matching the background worker's ~10s
// heartbeat cadence. A beat advances updatedAt (the freshness marker) but NOT
// lastActivityAt (the real phase-activity mark), so the two signals stay distinct:
// a reader still sees the true "time since last activity" while the run reads live.
export const FOREGROUND_HEARTBEAT_MS = 10_000;

// Keep the rail task one-liner compact: it is the user's slice description (not
// a model output), but the registry is a glance view, so cap it. Exported so
// other glance surfaces (the Studio live rail's background rows) apply the SAME
// bound to a raw JobRecord.task, which is otherwise an unbounded multi-line body.
export const MAX_TASK_LEN = 200;

export function compactTask(task: string): string {
	const t = task.replace(/\s+/g, " ").trim();
	return t.length > MAX_TASK_LEN ? `${t.slice(0, MAX_TASK_LEN - 3)}...` : t;
}

// The on-disk snapshot for one in-flight foreground iteration. Timestamps are
// stored (not pre-derived ages), so a reader derives elapsed/phase/last-activity
// against ITS OWN clock -- the writer's and reader's now need not agree.
export interface ForegroundSnapshot {
	runId: string;
	// The writing process, for read-time liveness (see pidAlive). A snapshot whose
	// pid is gone is treated as dead regardless of updatedAt.
	pid: number;
	scope: string;
	// The slice the loop is converging on (one-liner, capped). The user's own task
	// text, never a model output.
	task: string;
	// The same user-authored task in full, used only by Studio's selected-run
	// disclosure. It is still separate from model output, review prose, and config.
	taskFull?: string;
	// The stable repo namespace key (sha of the git top-level), matching how loop
	// logs are keyed. Opaque and safe; no raw cwd is exposed.
	repoKey: string;
	// A chit-managed worktree path, present only for an isolated run (already safe
	// to expose -- the same path the loop/run views surface). Absent for in_place runs.
	worktreePath?: string;
	// The iteration now running (session.iteration + 1 when it began).
	iteration: number;
	// The run's iteration budget, so a reader can show "iteration N of M" without
	// parsing statusLine. A plain counter, never model output.
	maxIterations?: number;
	// The per-call timeout override (ms) the run was launched with, if any. A budget
	// number only -- never a config/env value.
	callTimeoutMs?: number;
	phase: ForegroundPhase;
	// Loop start (ISO 8601), for total elapsed.
	startedAt: string;
	// When the current phase began (ISO 8601), for phase elapsed. Absent during the
	// brief "starting" spin-up before the first phase is known.
	phaseStartedAt?: string;
	// COMPLETED phases of the current iteration, in order (ISO 8601 marks; the reader
	// derives each duration against its own parse, per the stored-timestamps rule).
	// The active phase lives only in phase/phaseStartedAt above. Omitted while the
	// iteration has no completed phase yet; reset with each iteration's fresh
	// snapshot. Phase names and timestamps only -- never an output channel.
	phases?: Array<{ phase: string; startedAt: string; endedAt: string }>;
	// The latest activity mark (ISO 8601), for last-activity age.
	lastActivityAt: string;
	// When THIS snapshot was written (ISO 8601), the freshness marker the reader's
	// stale window is measured against.
	updatedAt: string;
	// Executing participants: agent + adapter only, the concise "what is running"
	// signal. The full provenance (permissions/config/env keys) is deliberately
	// omitted -- it lives in the audit run and the richer status views.
	participants?: Record<string, { agentId: string; adapter: string }>;
	// A compact phase descriptor (no live duration, which would go stale on disk);
	// the reader recomposes a duration-bearing line from the timestamps.
	statusLine: string;
}

// Base state dir for the foreground registry: $XDG_STATE_HOME/chit/foreground or
// ~/.local/state/chit/foreground. Mirrors the jobs / loops / audit state dirs.
export function defaultForegroundDir(): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "foreground");
}

// Parse a raw on-disk record into the EXACT compact snapshot this module promises,
// or undefined if it is malformed. This is the trust boundary: the file on disk may
// be half-written, from an older/other writer, or hand-edited, so the reader never
// re-emits it verbatim. Required scalars must all be present and well-typed (a
// half-written file reads as absent, never crashing a reader or looking healthy);
// optional fields are validated and RECONSTRUCTED field-by-field, so any extra keys
// a file carries (e.g. a nested participant config with env keys) cannot leak
// through the status surface. Pins the runId to the filename (the runId IS the file
// name) so a renamed/mismatched file is rejected.
function parseSnapshot(raw: unknown, expectedRunId: string): ForegroundSnapshot | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.runId !== "string" || !SAFE_RUN_ID.test(r.runId) || r.runId !== expectedRunId)
		return undefined;
	if (typeof r.pid !== "number" || !Number.isInteger(r.pid)) return undefined;
	if (typeof r.scope !== "string" || typeof r.task !== "string") return undefined;
	if (typeof r.repoKey !== "string") return undefined;
	if (typeof r.iteration !== "number") return undefined;
	if (typeof r.phase !== "string" || !FOREGROUND_PHASES.has(r.phase)) return undefined;
	if (typeof r.startedAt !== "string" || typeof r.lastActivityAt !== "string") return undefined;
	if (typeof r.updatedAt !== "string") return undefined;
	if (typeof r.statusLine !== "string") return undefined;
	// Rebuild from validated fields only: the returned object carries the compact
	// schema and nothing else, regardless of what extra keys the file held.
	const snapshot: ForegroundSnapshot = {
		runId: r.runId,
		pid: r.pid,
		scope: r.scope,
		task: r.task,
		repoKey: r.repoKey,
		iteration: r.iteration,
		phase: r.phase as ForegroundPhase,
		startedAt: r.startedAt,
		lastActivityAt: r.lastActivityAt,
		updatedAt: r.updatedAt,
		statusLine: r.statusLine,
	};
	if (typeof r.taskFull === "string") snapshot.taskFull = r.taskFull;
	if (typeof r.worktreePath === "string") snapshot.worktreePath = r.worktreePath;
	if (typeof r.phaseStartedAt === "string") snapshot.phaseStartedAt = r.phaseStartedAt;
	if (typeof r.maxIterations === "number") snapshot.maxIterations = r.maxIterations;
	if (typeof r.callTimeoutMs === "number") snapshot.callTimeoutMs = r.callTimeoutMs;
	const phases = sanitizePhases(r.phases);
	if (phases !== undefined) snapshot.phases = phases;
	const participants = sanitizeParticipants(r.participants);
	if (participants !== undefined) snapshot.participants = participants;
	return snapshot;
}

// Reduce a raw completed-phase timeline to the exact entries the snapshot promises
// (a known phase name plus its two ISO marks), dropping malformed entries and any
// extra keys an off-contract file may carry. Returns undefined when nothing valid
// remains, so the field is omitted rather than emitted empty -- same contract as
// sanitizeParticipants.
function sanitizePhases(
	raw: unknown,
): Array<{ phase: string; startedAt: string; endedAt: string }> | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: Array<{ phase: string; startedAt: string; endedAt: string }> = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.phase !== "string" || !FOREGROUND_PHASES.has(e.phase)) continue;
		if (typeof e.startedAt !== "string" || typeof e.endedAt !== "string") continue;
		out.push({ phase: e.phase, startedAt: e.startedAt, endedAt: e.endedAt });
	}
	return out.length > 0 ? out : undefined;
}

// Reduce a raw participants map to the agent+adapter pairs the snapshot promises,
// dropping any other per-participant fields (permissions/config/env keys) a
// malformed or older file may carry. A participant entry missing either id is
// skipped rather than partially trusted. Returns undefined when nothing valid
// remains, so the field is omitted rather than emitted empty.
function sanitizeParticipants(
	raw: unknown,
): Record<string, { agentId: string; adapter: string }> | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const out: Record<string, { agentId: string; adapter: string }> = {};
	for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
		if (p === null || typeof p !== "object") continue;
		const pp = p as Record<string, unknown>;
		if (typeof pp.agentId !== "string" || typeof pp.adapter !== "string") continue;
		out[id] = { agentId: pp.agentId, adapter: pp.adapter };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// True when a snapshot's writer is gone or it has gone unrefreshed too long. Both
// guards matter: pidAlive catches a crashed/exited process at once; the updatedAt
// window catches PID reuse (the pid resolves, but to an unrelated process that
// never refreshes this snapshot). See FOREGROUND_STALE_AFTER_MS.
function isStaleSnapshot(s: ForegroundSnapshot, nowMs: number, staleAfterMs: number): boolean {
	if (!pidAlive(s.pid)) return true;
	const updated = Date.parse(s.updatedAt);
	return !Number.isFinite(updated) || nowMs - updated > staleAfterMs;
}

export class ForegroundRegistry {
	constructor(
		private readonly baseDir: string = defaultForegroundDir(),
		// The writing pid, injectable for tests. Real callers use this process.
		private readonly pid: number = process.pid,
	) {}

	private path(runId: string): string {
		return join(this.baseDir, `${runId}.json`);
	}

	// Write (create or replace) the snapshot for a run, atomically. runId is the
	// filename, so it must be a safe slug; an unsafe id is ignored rather than
	// throwing, because the writer is a best-effort mirror that must never break a loop.
	write(snapshot: ForegroundSnapshot): void {
		if (!SAFE_RUN_ID.test(snapshot.runId)) return;
		mkdirSync(this.baseDir, { recursive: true });
		writeAtomic(this.path(snapshot.runId), snapshot);
	}

	// Remove a run's snapshot. Idempotent: a missing file is fine (the iteration may
	// have settled already, or never written one).
	remove(runId: string): void {
		if (!SAFE_RUN_ID.test(runId)) return;
		rmSync(this.path(runId), { force: true });
	}

	// All LIVE foreground snapshots: every well-formed file whose writer is still
	// alive and whose snapshot is fresh (see isStaleSnapshot). A corrupt, mid-write,
	// dead, or stale file is skipped, so one bad or abandoned file never breaks the
	// overview and a dead process never lingers as "healthy". Read-only: it never
	// deletes (status assembly stays side-effect-free); a dead/stale file is simply
	// filtered out. Dead-pid files are reclaimed separately by pruneDead, which a
	// caller may run opportunistically alongside (but outside) this read.
	list(nowMs: number, staleAfterMs: number = FOREGROUND_STALE_AFTER_MS): ForegroundSnapshot[] {
		if (!existsSync(this.baseDir)) return [];
		const live: ForegroundSnapshot[] = [];
		for (const name of readdirSync(this.baseDir)) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -".json".length);
			try {
				const raw: unknown = JSON.parse(readFileSync(join(this.baseDir, name), "utf-8"));
				const snapshot = parseSnapshot(raw, id);
				if (snapshot === undefined) continue;
				if (isStaleSnapshot(snapshot, nowMs, staleAfterMs)) continue;
				live.push(snapshot);
			} catch {
				// skip a corrupt / mid-write file
			}
		}
		return live;
	}

	// Unlink only the snapshot files whose writer pid is gone, returning the run ids
	// reclaimed (for callers/tests to assert what was pruned). This is the explicit,
	// side-effecting counterpart to list(): a foreground run id is a UUID, so a server
	// killed mid-iteration leaves a dead-pid file no later run overwrites, and list()
	// would filter it forever without ever removing it. Deleting a dead-pid file is
	// unambiguously safe -- the writer process is gone, so nothing will refresh it.
	//
	// Deliberately narrow. It does NOT delete:
	//   - stale-but-pid-alive files: the stale window is the PID-reuse guard, a read-time
	//     filter only; a live pid may still be the real writer mid-write, so we keep it.
	//   - corrupt / mismatched files: parseSnapshot can't recover a trustworthy pid from
	//     them, so we leave them to list-filtering rather than guess they are abandoned.
	// An unreadable file is left in place for the same reason. Best-effort by intent:
	// callers wrap this so a prune failure never fails the read it accompanies.
	pruneDead(): string[] {
		if (!existsSync(this.baseDir)) return [];
		const pruned: string[] = [];
		for (const name of readdirSync(this.baseDir)) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -".json".length);
			try {
				const raw: unknown = JSON.parse(readFileSync(join(this.baseDir, name), "utf-8"));
				const snapshot = parseSnapshot(raw, id);
				if (snapshot === undefined) continue; // corrupt/mismatched: leave for list-filtering
				if (pidAlive(snapshot.pid)) continue; // alive (incl. stale-but-alive): keep
				rmSync(join(this.baseDir, name), { force: true });
				pruned.push(id);
			} catch {
				// unreadable file: leave it, do not delete what we cannot parse
			}
		}
		return pruned;
	}

	// The pid this registry stamps onto snapshots it writes (for tests that assert
	// liveness filtering without spawning a second process).
	get writerPid(): number {
		return this.pid;
	}

	// Build the snapshot for a session's current in-flight iteration, or undefined
	// when the iteration has settled (no activity) -- the caller removes the file
	// then. Reads only the session's own fields + its live activity mark; derives no
	// ages (timestamps are stored for the reader to derive against its own clock).
	snapshotFor(session: ConvergeSession, nowMs: number): ForegroundSnapshot | undefined {
		const a = session.activity;
		if (a === undefined) return undefined;
		const phase: ForegroundPhase = a.phase ?? "starting";
		return {
			runId: session.loopId,
			pid: this.pid,
			scope: session.scope,
			task: compactTask(session.task),
			taskFull: session.task,
			repoKey: repoKeyOf(session.cwd),
			...(session.worktreePath !== undefined && { worktreePath: session.worktreePath }),
			iteration: a.iteration,
			maxIterations: session.maxIterations,
			...(session.callTimeoutMs !== undefined && { callTimeoutMs: session.callTimeoutMs }),
			phase,
			startedAt: new Date(session.startedAtMs).toISOString(),
			...(a.phaseStartedAtMs !== undefined && {
				phaseStartedAt: new Date(a.phaseStartedAtMs).toISOString(),
			}),
			// The current iteration's completed phases, as stored timestamps (never
			// pre-derived durations). The engine starts each iteration's activity with an
			// empty history, so this never spans iterations; omitted until one completes.
			...(a.phases.length > 0 && {
				phases: a.phases.map((p) => ({
					phase: p.phase,
					startedAt: new Date(p.startedAtMs).toISOString(),
					endedAt: new Date(p.endedAtMs).toISOString(),
				})),
			}),
			lastActivityAt: new Date(a.lastActivityAtMs).toISOString(),
			updatedAt: new Date(nowMs).toISOString(),
			...(compactParticipants(session.participants) && {
				participants: compactParticipants(session.participants),
			}),
			statusLine: `iteration ${a.iteration} · ${phase}`,
		};
	}

	// Sync a session's live activity to disk: write the current snapshot while an
	// iteration is in flight, or remove it once the iteration has settled. Wired as
	// the session's onActivityChange callback, so it fires on iteration start, every
	// phase transition (including "cancelling"), and on settle. Best-effort by
	// contract: a registry I/O failure must NEVER break the loop, so all errors are
	// swallowed (the mirror is observability, not the source of truth).
	sync(session: ConvergeSession, nowMs: number = Date.now()): void {
		try {
			const snapshot = this.snapshotFor(session, nowMs);
			if (snapshot) this.write(snapshot);
			else this.remove(session.loopId);
		} catch {
			// best-effort mirror; never surface to the loop
		}
	}
}

// Reduce the full participant provenance to the concise pair the registry exposes
// (agent + adapter). Returns undefined when there is nothing to show, so the
// snapshot omits the field rather than carrying an empty object.
function compactParticipants(
	participants: ConvergeSession["participants"],
): Record<string, { agentId: string; adapter: string }> | undefined {
	if (participants === undefined) return undefined;
	const out: Record<string, { agentId: string; adapter: string }> = {};
	for (const [id, p] of Object.entries(participants)) {
		out[id] = { agentId: p.agentId, adapter: p.adapter };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// A snapshot re-presented for the chit_status overview: the stored fields plus
// ages derived against the reader's clock (so durations are live, not frozen at
// write time). run_id matches the unified handle; pid identifies the owning
// session. Omitted ages (an unparseable or future timestamp) simply do not appear.
export interface ForegroundActivitySummary {
	run_id: string;
	pid: number;
	scope: string;
	task: string;
	taskFull?: string;
	repoKey: string;
	worktreePath?: string;
	iteration: number;
	maxIterations?: number;
	callTimeoutMs?: number;
	phase: ForegroundPhase;
	statusLine: string;
	elapsedMs?: number;
	phaseElapsedMs?: number;
	lastActivityAgeMs?: number;
	participants?: Record<string, { agentId: string; adapter: string }>;
}

function ageMs(iso: string | undefined, nowMs: number): number | undefined {
	if (iso === undefined) return undefined;
	const t = Date.parse(iso);
	if (!Number.isFinite(t) || nowMs < t) return undefined;
	return nowMs - t;
}

export function summarizeForegroundForStatus(
	s: ForegroundSnapshot,
	nowMs: number,
): ForegroundActivitySummary {
	return {
		run_id: s.runId,
		pid: s.pid,
		scope: s.scope,
		task: s.task,
		...(s.taskFull !== undefined && { taskFull: s.taskFull }),
		repoKey: s.repoKey,
		...(s.worktreePath !== undefined && { worktreePath: s.worktreePath }),
		iteration: s.iteration,
		...(s.maxIterations !== undefined && { maxIterations: s.maxIterations }),
		...(s.callTimeoutMs !== undefined && { callTimeoutMs: s.callTimeoutMs }),
		phase: s.phase,
		statusLine: s.statusLine,
		...(ageMs(s.startedAt, nowMs) !== undefined && { elapsedMs: ageMs(s.startedAt, nowMs) }),
		...(ageMs(s.phaseStartedAt, nowMs) !== undefined && {
			phaseElapsedMs: ageMs(s.phaseStartedAt, nowMs),
		}),
		...(ageMs(s.lastActivityAt, nowMs) !== undefined && {
			lastActivityAgeMs: ageMs(s.lastActivityAt, nowMs),
		}),
		// Reconstruct participants through the same sanitizer the disk reader uses, so this
		// surface emits agent+adapter ONLY even if a caller hands it an off-contract snapshot.
		// The real path (list -> summarize) is already sanitized at the read boundary; this is
		// belt-and-suspenders for the exported function, never a second source of truth.
		...((): { participants?: Record<string, { agentId: string; adapter: string }> } => {
			const participants = sanitizeParticipants(s.participants);
			return participants !== undefined ? { participants } : {};
		})(),
	};
}

// Serialize to a unique temp file in the same dir, then rename into place. Rename
// is atomic on one filesystem, so a concurrent reader sees the old or new file,
// never a partial one. An interrupted write leaves at most a stray .tmp.
function writeAtomic(path: string, snapshot: ForegroundSnapshot): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
