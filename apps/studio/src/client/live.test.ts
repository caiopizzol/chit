// Unit tests for the live-monitor pure helpers: age formatting, row identity,
// the phase label, and the snapshot diff that feeds the console. No React, no
// timer, no network - just data in, data out.

import { describe, expect, test } from "bun:test";
import type { BackgroundLiveRow, ForegroundLiveRow, LiveActivity } from "../server/types.ts";
import { diffActivity, flattenRows, formatAge, phaseLabel, rowKey } from "./live.ts";

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

describe("phaseLabel", () => {
	test("foreground uses phase", () => {
		expect(phaseLabel(fg({ phase: "reviewing" }))).toBe("reviewing");
	});

	test("background leads with display and appends phase when present", () => {
		expect(phaseLabel(bg({ display: "running", phase: undefined }))).toBe("running");
		expect(phaseLabel(bg({ display: "running", phase: "reviewing" }))).toBe("running · reviewing");
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
