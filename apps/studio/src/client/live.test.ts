// Unit tests for the live-monitor pure helpers: age formatting, row identity,
// the phase label, the selected-run detail shaping, and the snapshot diff that
// feeds the console. No React, no timer, no network - just data in, data out.

import { describe, expect, test } from "bun:test";
import type { BackgroundLiveRow, ForegroundLiveRow, LiveActivity } from "../server/types.ts";
import type { LiveCancelOutcome } from "./api.ts";
import {
	activeRole,
	agentBlockViews,
	cancelAvailable,
	cancelMessage,
	cancelPending,
	concisePhase,
	detailAges,
	diffActivity,
	flattenRows,
	formatAge,
	headPhaseElapsed,
	iterationHint,
	liveBody,
	phaseLabel,
	rowKey,
} from "./live.ts";

function fg(over: Partial<ForegroundLiveRow> = {}): ForegroundLiveRow {
	return {
		source: "foreground",
		runId: "fg-1",
		scope: "src",
		task: "converge the parser",
		phase: "implementing",
		statusLine: "iteration 2",
		...over,
	};
}

function bg(over: Partial<BackgroundLiveRow> = {}): BackgroundLiveRow {
	return {
		source: "background",
		runId: "bg-1",
		scope: "routes",
		display: "running",
		statusLine: "running",
		...over,
	};
}

function activity(over: Partial<LiveActivity> = {}): LiveActivity {
	return { foreground: [], background: [], ...over };
}

describe("formatAge", () => {
	test("undefined / non-finite / negative render the placeholder", () => {
		expect(formatAge(undefined)).toBe("-");
		expect(formatAge(Number.NaN)).toBe("-");
		expect(formatAge(-5)).toBe("-");
	});

	test("seconds, minutes, and hours", () => {
		expect(formatAge(500)).toBe("1s");
		expect(formatAge(12_000)).toBe("12s");
		expect(formatAge(65_000)).toBe("1m 5s");
		expect(formatAge(3_661_000)).toBe("1h 1m");
	});
});

describe("rowKey / flattenRows", () => {
	test("key is source-tagged so a shared runId stays distinct", () => {
		expect(rowKey(fg({ runId: "x" }))).toBe("foreground:x");
		expect(rowKey(bg({ runId: "x" }))).toBe("background:x");
	});

	test("flatten lists foreground before background", () => {
		const a = activity({ foreground: [fg()], background: [bg()] });
		expect(flattenRows(a).map(rowKey)).toEqual(["foreground:fg-1", "background:bg-1"]);
	});
});

describe("selected-run action helpers", () => {
	test("cancelAvailable is true only for background rows", () => {
		expect(cancelAvailable(bg())).toBe(true);
		expect(cancelAvailable(fg())).toBe(false);
	});

	test("cancelPending is true only for a background row already in the cancelling phase", () => {
		expect(cancelPending(bg({ phase: "cancelling" }))).toBe(true);
		expect(cancelPending(bg({ phase: "reviewing" }))).toBe(false);
		expect(cancelPending(bg({ phase: undefined }))).toBe(false);
		// A foreground row never offers cancel, so it is never pending either.
		expect(cancelPending(fg({ phase: "cancelling" }))).toBe(false);
	});

	test("cancelMessage maps each outcome to a calm one-liner", () => {
		const cases: Array<[LiveCancelOutcome, string]> = [
			[{ kind: "requested", state: "running", signaled: true }, "cancel requested"],
			[
				{ kind: "requested", state: "queued", signaled: false },
				"cancel requested · no live worker",
			],
			[{ kind: "already-finished", state: "completed" }, "already completed"],
			[{ kind: "not-found" }, "run no longer live"],
			[{ kind: "error", status: 501, error: "live actions not available" }, "cancel failed · 501"],
		];
		for (const [outcome, expected] of cases) {
			expect(cancelMessage(outcome)).toBe(expected);
		}
	});
});

describe("phaseLabel", () => {
	test("foreground uses phase", () => {
		expect(phaseLabel(fg({ phase: "reviewing" }))).toBe("reviewing");
	});

	test("background leads with display and appends phase when present", () => {
		expect(phaseLabel(bg({ display: "running", phase: undefined }))).toBe("running");
		expect(phaseLabel(bg({ display: "running", phase: "reviewing" }))).toBe("running · reviewing");
	});
});

describe("concisePhase", () => {
	test("foreground uses phase", () => {
		expect(concisePhase(fg({ phase: "reviewing" }))).toBe("reviewing");
	});

	test("background uses phase when present, otherwise display", () => {
		expect(concisePhase(bg({ display: "running", phase: "reviewing" }))).toBe("reviewing");
		expect(concisePhase(bg({ display: "queued", phase: undefined }))).toBe("queued");
	});
});

describe("activeRole", () => {
	test("maps the phase vocabulary to participant roles", () => {
		expect(activeRole(fg({ phase: "implementing" }))).toBe("implementer");
		expect(activeRole(fg({ phase: "planning" }))).toBe("implementer");
		expect(activeRole(fg({ phase: "reviewing" }))).toBe("reviewer");
		expect(activeRole(fg({ phase: "running checks" }))).toBe("checks");
		expect(activeRole(fg({ phase: "cancelling" }))).toBe("other");
	});

	test("a background row without a phase falls back to its display", () => {
		expect(activeRole(bg({ display: "queued", phase: undefined }))).toBe("other");
		expect(activeRole(bg({ display: "running", phase: "reviewing" }))).toBe("reviewer");
	});
});

describe("agentBlockViews", () => {
	const participants = {
		implementer: { agentId: "claude-code", adapter: "claude-cli" },
		reviewer: { agentId: "codex", adapter: "codex-cli" },
	};

	test("no participants yields no blocks", () => {
		expect(agentBlockViews(fg({ participants: undefined }))).toEqual([]);
	});

	test("the block matching the active phase is live and carries the phase elapsed", () => {
		const views = agentBlockViews(fg({ phase: "reviewing", participants, phaseElapsedMs: 65_000 }));
		expect(views).toEqual([
			{ role: "implementer", agentId: "claude-code", adapter: "claude-cli", live: false },
			{
				role: "reviewer",
				agentId: "codex",
				adapter: "codex-cli",
				live: true,
				phaseElapsed: "1m 5s",
			},
		]);
	});

	test("an underivable phase elapsed leaves the live block without a timing badge", () => {
		const views = agentBlockViews(
			fg({ phase: "implementing", participants, phaseElapsedMs: undefined }),
		);
		expect(views[0]).toEqual({
			role: "implementer",
			agentId: "claude-code",
			adapter: "claude-cli",
			live: true,
		});
	});

	test("a phase no block claims lights nothing and assigns no timing", () => {
		const views = agentBlockViews(fg({ phase: "cancelling", participants, phaseElapsedMs: 5000 }));
		expect(views.every((v) => !v.live && v.phaseElapsed === undefined)).toBe(true);
	});

	test("abbreviated participant keys (impl / rev) light the active block too", () => {
		// The hosts report abbreviated role keys (foreground registry, server
		// fixtures), so the matching must not depend on full role names.
		const abbreviated = {
			impl: { agentId: "claude", adapter: "claude-cli" },
			rev: { agentId: "codex", adapter: "codex-cli" },
		};
		const implementing = agentBlockViews(
			fg({ phase: "implementing", participants: abbreviated, phaseElapsedMs: 4000 }),
		);
		expect(implementing).toEqual([
			{ role: "impl", agentId: "claude", adapter: "claude-cli", live: true, phaseElapsed: "4s" },
			{ role: "rev", agentId: "codex", adapter: "codex-cli", live: false },
		]);
		const reviewing = agentBlockViews(
			fg({ phase: "reviewing", participants: abbreviated, phaseElapsedMs: 4000 }),
		);
		expect(reviewing).toEqual([
			{ role: "impl", agentId: "claude", adapter: "claude-cli", live: false },
			{ role: "rev", agentId: "codex", adapter: "codex-cli", live: true, phaseElapsed: "4s" },
		]);
	});

	test("a checks phase gets a synthetic chit block with the phase elapsed", () => {
		const views = agentBlockViews(
			fg({ phase: "running required checks", participants, phaseElapsedMs: 41_000 }),
		);
		expect(views).toEqual([
			{ role: "implementer", agentId: "claude-code", adapter: "claude-cli", live: false },
			{ role: "reviewer", agentId: "codex", adapter: "codex-cli", live: false },
			{
				role: "checks",
				agentId: "chit",
				adapter: "required checks",
				live: true,
				phaseElapsed: "41s",
			},
		]);
	});
});

describe("headPhaseElapsed", () => {
	const participants = {
		implementer: { agentId: "claude-code", adapter: "claude-cli" },
	};

	test("absent when the live agent block already carries the timing", () => {
		expect(
			headPhaseElapsed(fg({ phase: "implementing", participants, phaseElapsedMs: 5000 })),
		).toBeUndefined();
	});

	test("present when no block claims the phase, or no participants are reported", () => {
		expect(headPhaseElapsed(fg({ phase: "cancelling", participants, phaseElapsedMs: 5000 }))).toBe(
			"5s",
		);
		expect(
			headPhaseElapsed(
				fg({ phase: "implementing", participants: undefined, phaseElapsedMs: 5000 }),
			),
		).toBe("5s");
	});

	test("absent for an abbreviated participant key that claims the phase", () => {
		const abbreviated = { impl: { agentId: "claude", adapter: "claude-cli" } };
		expect(
			headPhaseElapsed(
				fg({ phase: "implementing", participants: abbreviated, phaseElapsedMs: 4000 }),
			),
		).toBeUndefined();
	});

	test("absent when the synthetic checks block carries the timing", () => {
		expect(
			headPhaseElapsed(
				fg({
					phase: "running required checks",
					participants,
					phaseElapsedMs: 41_000,
				}),
			),
		).toBeUndefined();
	});

	test("absent when the row reports no phase elapsed at all", () => {
		expect(headPhaseElapsed(fg({ phaseElapsedMs: undefined }))).toBeUndefined();
	});
});

describe("iterationHint", () => {
	test("derives a compact hint from the statusLine vocabulary", () => {
		expect(iterationHint(fg({ statusLine: "iteration 3 · implementing" }))).toBe("iter 3");
		expect(iterationHint(bg({ statusLine: "iteration 12 · pass · 2/2 checks passed" }))).toBe(
			"iter 12",
		);
	});

	test("a statusLine without an iteration count yields no hint", () => {
		expect(iterationHint(bg({ statusLine: "running" }))).toBeUndefined();
	});
});

describe("detailAges", () => {
	test("foreground shows elapsed only -- no last-activity row, no phase row", () => {
		expect(
			detailAges(fg({ elapsedMs: 1000, phaseElapsedMs: 500, lastActivityAgeMs: 200 })),
		).toEqual([["elapsed", 1000]]);
	});

	test("background keeps the worker heartbeat next to elapsed", () => {
		expect(detailAges(bg({ elapsedMs: 1000, lastHeartbeatAgeMs: 200 }))).toEqual([
			["elapsed", 1000],
			["heartbeat", 200],
		]);
	});
});

describe("diffActivity", () => {
	test("a null prev establishes a silent baseline", () => {
		expect(diffActivity(null, activity({ foreground: [fg()] }))).toEqual([]);
	});

	test("a new row reads as appeared with its phase", () => {
		const out = diffActivity(activity(), activity({ foreground: [fg()] }));
		expect(out).toEqual([{ runId: "fg-1", source: "foreground", text: "appeared · implementing" }]);
	});

	test("a phase change reads as an arrow transition", () => {
		const out = diffActivity(
			activity({ foreground: [fg({ phase: "implementing" })] }),
			activity({ foreground: [fg({ phase: "reviewing" })] }),
		);
		expect(out).toEqual([
			{ runId: "fg-1", source: "foreground", text: "implementing → reviewing" },
		]);
	});

	test("a background display change is caught even when phase holds", () => {
		const out = diffActivity(
			activity({ background: [bg({ display: "running" })] }),
			activity({ background: [bg({ display: "stale" })] }),
		);
		expect(out).toEqual([{ runId: "bg-1", source: "background", text: "running → stale" }]);
	});

	test("a vanished row reads as disappeared", () => {
		const out = diffActivity(activity({ foreground: [fg()] }), activity());
		expect(out).toEqual([{ runId: "fg-1", source: "foreground", text: "disappeared" }]);
	});

	test("a steady snapshot with only an age tick produces no console noise", () => {
		const out = diffActivity(
			activity({ foreground: [fg({ lastActivityAgeMs: 500 })] }),
			activity({ foreground: [fg({ lastActivityAgeMs: 3000 })] }),
		);
		expect(out).toEqual([]);
	});
});

describe("liveBody", () => {
	test("rows present render the live grid regardless of log", () => {
		expect(liveBody(activity({ foreground: [fg()] }), 0)).toBe("grid");
		expect(liveBody(activity({ background: [bg()] }), 5)).toBe("grid");
	});

	test("no rows and no log stays calm and minimal", () => {
		expect(liveBody(activity(), 0)).toBe("empty");
	});

	test("no rows but a populated console keeps the console visible", () => {
		expect(liveBody(activity(), 1)).toBe("empty-with-console");
	});

	test("same open after disappearance: the row clears but its console survives", () => {
		// Mirror the live flow within one open session. A row was alive, then
		// disappears. The diff records the "disappeared" line, and once that line is
		// in the retained console the empty overlay must still show it rather than
		// collapsing to the calm state. (useLive keeps the log across polls while
		// the monitor stays open, so logCount stays > 0 here.)
		const before = activity({ foreground: [fg()] });
		const after = activity();
		const transitions = diffActivity(before, after);
		expect(transitions).toEqual([{ runId: "fg-1", source: "foreground", text: "disappeared" }]);
		expect(liveBody(after, transitions.length)).toBe("empty-with-console");
	});

	test("close then reopen with no live rows starts calm and minimal", () => {
		// The other path the dogfood polish must honor: a fresh open resets the
		// read session, including the console (useLive clears `log`), so a reopen
		// with nothing live renders the minimal empty state, never the previous
		// session's lingering transition tail. With the log cleared, logCount is 0.
		expect(liveBody(activity(), 0)).toBe("empty");
	});
});
