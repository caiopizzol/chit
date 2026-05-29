// Read-only convergence-log state for the Loops drawer (docs/loop-view-v0.md).
// The list loads on mount; selecting a loop fetches its records on demand. Both
// sides carry explicit loading / error / ready states so the view can render an
// honest empty/loading/error UI. All data comes from the server routes; the
// client never reads the filesystem or parses JSONL. Mirrors useInstalled.

import type { LoopRecord } from "@chit/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoopSummary } from "../server/types.ts";
import { fetchLoop, fetchLoops, StudioApiError } from "./api.ts";

function errMessage(e: unknown): string {
	if (e instanceof StudioApiError) return `${e.status}: ${e.message}`;
	if (e instanceof Error) return e.message;
	return String(e);
}

export type LoopListState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; loops: LoopSummary[] };

export type LoopDetailState =
	| { status: "idle" }
	| { status: "loading"; loopId: string }
	| { status: "error"; loopId: string; error: string }
	| { status: "ready"; loopId: string; records: LoopRecord[] };

export interface LoopsState {
	list: LoopListState;
	detail: LoopDetailState;
	refresh: () => Promise<void>;
	select: (loopId: string) => Promise<void>;
	clearSelection: () => void;
}

export function useLoops(): LoopsState {
	const [list, setList] = useState<LoopListState>({ status: "loading" });
	const [detail, setDetail] = useState<LoopDetailState>({ status: "idle" });

	// Monotonic request tokens: only the latest call for each side may publish,
	// so a slower earlier response can never overwrite a newer one (latest wins).
	// clearSelection bumps the detail token, invalidating any in-flight select.
	const listSeq = useRef(0);
	const detailSeq = useRef(0);

	const refresh = useCallback(async () => {
		const seq = ++listSeq.current;
		setList({ status: "loading" });
		try {
			const loops = await fetchLoops();
			if (seq === listSeq.current) setList({ status: "ready", loops });
		} catch (e) {
			if (seq === listSeq.current) setList({ status: "error", error: errMessage(e) });
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const select = useCallback(async (loopId: string) => {
		const seq = ++detailSeq.current;
		setDetail({ status: "loading", loopId });
		try {
			const records = await fetchLoop(loopId);
			if (seq === detailSeq.current) setDetail({ status: "ready", loopId, records });
		} catch (e) {
			if (seq === detailSeq.current) setDetail({ status: "error", loopId, error: errMessage(e) });
		}
	}, []);

	const clearSelection = useCallback(() => {
		detailSeq.current++; // invalidate any in-flight select
		setDetail({ status: "idle" });
	}, []);

	return { list, detail, refresh, select, clearSelection };
}
