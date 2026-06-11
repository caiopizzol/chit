// Live-tower state: a light poll of GET /api/live while the Live Tower page is
// mounted, plus a derived selection and a local console of state transitions.
// The tower is the page now, not an overlay, so there is no hidden inactive
// state: polling runs for the lifetime of the mount and the effect's cleanup
// cancels the in-flight loop on unmount. Errors are unobtrusive and recoverable:
// the last good snapshot stays on screen, an error string is surfaced, and the
// next successful poll clears it. A page reload starts a fresh read session (no
// snapshot carries across reloads). Request tokens make the latest read win
// without a state library.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveActivity, LiveActivityRow } from "../server/types.ts";
import { fetchLive, StudioApiError } from "./api.ts";
import { diffActivity, flattenRows, rowKey } from "./live.ts";

const POLL_MS = 2500;
// The console is a recent-activity tail, not an archive: cap it so a long-lived
// monitor never grows without bound.
const MAX_LOG = 50;

const EMPTY: LiveActivity = { foreground: [], background: [] };

function errMessage(e: unknown): string {
	if (e instanceof StudioApiError) return `${e.status}: ${e.message}`;
	if (e instanceof Error) return e.message;
	return String(e);
}

// One console line: a transition stamped with a local wall-clock time and a
// monotonic id for a stable React key.
export interface LiveConsoleEntry {
	id: number;
	time: string;
	runId: string;
	source: "foreground" | "background";
	text: string;
}

export interface LiveState {
	activity: LiveActivity;
	status: "loading" | "ready" | "error";
	error: string | null;
	log: LiveConsoleEntry[];
	selectedKey: string | null;
	selected: LiveActivityRow | null;
	select: (key: string) => void;
	// Trigger an immediate re-poll without resetting the read session (so the
	// selection and console survive). Used after a mutating action -- e.g. a
	// cancel -- so the rail reflects the new state promptly instead of waiting out
	// the poll interval. A no-op once the effect has torn down.
	refresh: () => void;
}

export function useLive(): LiveState {
	const [activity, setActivity] = useState<LiveActivity>(EMPTY);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const [error, setError] = useState<string | null>(null);
	const [log, setLog] = useState<LiveConsoleEntry[]>([]);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	// The previous snapshot the diff runs against, and a monotonic id for log
	// keys. Both are refs: they must survive renders without re-triggering the
	// poll effect. `succeeded` keeps the loading -> error transition honest (an
	// error before the first success shows the error state; an error after keeps
	// the last good data and only flags the error string).
	const prevRef = useRef<LiveActivity | null>(null);
	const seqRef = useRef(0);
	const succeededRef = useRef(false);
	// The current session's immediate-repoll trigger, installed by the poll effect
	// and cleared on teardown. `refresh` calls through this so a manual re-poll
	// always targets the live session, never a torn-down one.
	const pokeRef = useRef<(() => void) | null>(null);

	const appendLog = useCallback(
		(entries: { runId: string; source: "foreground" | "background"; text: string }[]) => {
			if (entries.length === 0) return;
			const time = new Date().toLocaleTimeString();
			setLog((cur) => {
				const stamped = entries.map((e) => ({ id: ++seqRef.current, time, ...e }));
				return [...stamped.reverse(), ...cur].slice(0, MAX_LOG);
			});
		},
		[],
	);

	useEffect(() => {
		// Mounting the tower starts a fresh read session. The rail must answer
		// "what is alive NOW", so we begin from a loading state with an empty
		// snapshot and an armed loading -> error gate. The diff baseline starts
		// null, so the first tick records no transitions and never replays the
		// already-running set as a burst of "appeared" lines. The last good
		// snapshot is retained only across transient errors while the page stays
		// mounted (see the catch below); a reload starts over.
		prevRef.current = null;
		succeededRef.current = false;
		setActivity(EMPTY);
		setStatus("loading");
		setError(null);
		setSelectedKey(null);
		// The console is part of the read session too: it starts blank so a session
		// with no live rows shows the calm empty state. Within the mounted session
		// the log persists (that is what keeps the final "disappeared" line visible
		// after the row clears); only a reload wipes it.
		setLog([]);
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		// Single scheduling authority. `inFlight` prevents overlapping polls (a
		// manual poke during an in-flight poll never runs a second fetch); a poke
		// that arrives mid-flight sets `pokeQueued` so the in-flight poll reschedules
		// immediately on settle instead of waiting out POLL_MS.
		let inFlight = false;
		let pokeQueued = false;

		function schedule() {
			timer = setTimeout(() => void tick(), pokeQueued ? 0 : POLL_MS);
		}

		async function tick() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (inFlight) {
				// A poll is already running; mark that another read is wanted and let
				// the running poll's settle path reschedule promptly.
				pokeQueued = true;
				return;
			}
			inFlight = true;
			pokeQueued = false; // this read services any pending poke
			try {
				const next = await fetchLive();
				if (cancelled) return;
				const transitions = diffActivity(prevRef.current, next);
				prevRef.current = next;
				succeededRef.current = true;
				setActivity(next);
				setStatus("ready");
				setError(null);
				appendLog(transitions);
			} catch (e) {
				if (cancelled) return;
				setError(errMessage(e));
				if (!succeededRef.current) setStatus("error");
			} finally {
				inFlight = false;
				if (!cancelled) schedule();
			}
		}

		// Expose an immediate re-poll for this session. A poke marks intent and runs
		// tick(); tick() clears any pending timer and either reads now or (if a read
		// is in flight) defers to the in-flight poll's prompt reschedule.
		pokeRef.current = () => {
			if (cancelled) return;
			pokeQueued = true;
			void tick();
		};

		void tick();
		return () => {
			cancelled = true;
			pokeRef.current = null;
			if (timer) clearTimeout(timer);
		};
	}, [appendLog]);

	// Keep the selection valid: when the selected run disappears (or nothing is
	// selected yet), fall back to the first available row. When everything is
	// gone the stale key is harmless -- `selected` resolves to null and the
	// detail pane shows its empty state.
	useEffect(() => {
		const rows = flattenRows(activity);
		if (rows.length === 0) return;
		const stillThere = selectedKey !== null && rows.some((r) => rowKey(r) === selectedKey);
		if (!stillThere) setSelectedKey(rowKey(rows[0] as LiveActivityRow));
	}, [activity, selectedKey]);

	const selected = useMemo(() => {
		if (selectedKey === null) return null;
		return flattenRows(activity).find((r) => rowKey(r) === selectedKey) ?? null;
	}, [activity, selectedKey]);

	const select = useCallback((key: string) => {
		setSelectedKey(key);
	}, []);

	const refresh = useCallback(() => {
		pokeRef.current?.();
	}, []);

	return { activity, status, error, log, selectedKey, selected, select, refresh };
}
