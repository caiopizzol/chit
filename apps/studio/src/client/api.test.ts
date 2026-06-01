// Unit tests for the read-only loop fetch helpers. Stubs sessionStorage (so
// getToken resolves) and global fetch (so no network), and asserts the helpers
// hit the right URL with the bearer token, parse the body, and surface non-2xx
// as a StudioApiError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LoopRecord } from "@chit-run/core";
import type { LoopSummary } from "../server/types.ts";
import { fetchLoop, fetchLoops, StudioApiError } from "./api.ts";
import { TOKEN_STORAGE_KEY } from "./boot.ts";

const realFetch = globalThis.fetch;

interface Call {
	url: string;
	headers: Record<string, string>;
}

function mock(status: number, body: unknown): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url: String(input), headers });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
	return calls;
}

beforeEach(() => {
	const store = new Map<string, string>([[TOKEN_STORAGE_KEY, "tok"]]);
	globalThis.sessionStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
		clear: () => store.clear(),
		key: () => null,
		length: 0,
	} as Storage;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fetchLoops", () => {
	test("GETs /api/loops with the bearer token and parses the array", async () => {
		const summaries: LoopSummary[] = [
			{
				loopId: "A",
				scope: "s",
				task: "t",
				status: "converged",
				iterations: 1,
				totalElapsedMs: 5000,
				startedAt: "2026-05-29T10:00:00.000Z",
			},
		];
		const calls = mock(200, summaries);
		const out = await fetchLoops();
		expect(out).toEqual(summaries);
		expect(calls[0]?.url).toBe("/api/loops");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("throws StudioApiError on a non-2xx response", async () => {
		mock(500, "boom");
		await expect(fetchLoops()).rejects.toBeInstanceOf(StudioApiError);
	});
});

describe("fetchLoop", () => {
	test("GETs /api/loops/:id (id encoded) and parses the records", async () => {
		const records: LoopRecord[] = [
			{
				type: "loop",
				schema: 1,
				loopId: "L1",
				scope: "s",
				task: "t",
				repo: "/x",
				startedAt: "2026-05-29T10:00:00.000Z",
				maxIterations: 3,
			},
			{
				type: "iteration",
				n: 1,
				implementSummary: "x",
				changedFiles: [],
				checksRun: "t",
				verdict: "proceed",
				findingCount: 0,
				decision: "proceed",
				checkDurationMs: 1,
				at: "2026-05-29T10:01:00.000Z",
			},
		];
		const calls = mock(200, records);
		const out = await fetchLoop("L1");
		expect(out).toEqual(records);
		expect(calls[0]?.url).toBe("/api/loops/L1");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("throws StudioApiError on 404", async () => {
		mock(404, "not found");
		await expect(fetchLoop("nope")).rejects.toBeInstanceOf(StudioApiError);
	});
});
