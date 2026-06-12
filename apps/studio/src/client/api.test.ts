// Unit tests for the mounted LiveTower fetch helpers. Stubs sessionStorage (so
// getToken resolves) and global fetch (so no network), and asserts the helpers
// hit the right URL with the bearer token, parse the body, and surface non-2xx
// as a StudioApiError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DeclaredRoutinesView, EffectiveConfigView, LiveActivity } from "../server/types.ts";
import {
	cancelLiveRun,
	fetchEffectiveConfig,
	fetchLive,
	fetchRoutines,
	StudioApiError,
} from "./api.ts";
import { TOKEN_STORAGE_KEY } from "./boot.ts";

const realFetch = globalThis.fetch;

interface Call {
	url: string;
	headers: Record<string, string>;
	method?: string;
	body?: string;
}

function mock(status: number, body: unknown): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url: String(input),
			headers,
			method: init?.method,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
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

describe("fetchLive", () => {
	test("GETs /api/live with the bearer token and parses the snapshot", async () => {
		const live: LiveActivity = {
			foreground: [
				{
					source: "foreground",
					runId: "fg-1",
					scope: "src",
					task: "converge the parser",
					taskFull: "converge the parser with full context",
					phase: "implementing",
					statusLine: "iteration 2",
				},
			],
			background: [],
		};
		const calls = mock(200, live);
		const out = await fetchLive();
		expect(out).toEqual(live);
		expect(calls[0]?.url).toBe("/api/live");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("throws StudioApiError on a non-2xx response", async () => {
		mock(500, "boom");
		await expect(fetchLive()).rejects.toBeInstanceOf(StudioApiError);
	});
});

describe("fetchEffectiveConfig", () => {
	const view: EffectiveConfigView = {
		configPath: "/home/u/.config/chit/config.json",
		agents: [
			{
				id: "claude",
				adapter: "claude-cli",
				origin: "builtin",
				strictMcp: true,
				passModelOnResume: false,
			},
		],
		roles: [],
		recipes: [],
	};

	test("GETs /api/config with the bearer token and maps a 200 to ok", async () => {
		const calls = mock(200, view);
		const out = await fetchEffectiveConfig();
		expect(out).toEqual({ kind: "ok", config: view });
		expect(calls[0]?.url).toBe("/api/config");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("maps a 501 (no host config source) to unavailable", async () => {
		mock(501, "config view not available");
		expect(await fetchEffectiveConfig()).toEqual({ kind: "unavailable" });
	});

	test("maps a 422 load failure to the error outcome, not a throw", async () => {
		mock(422, "config load failed: /repo/chit.config.json: invalid JSON");
		const out = await fetchEffectiveConfig();
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.status).toBe(422);
			expect(out.error).toContain("chit.config.json");
		}
	});

	test("throws StudioApiError on 401 (auth failure is not a config state)", async () => {
		mock(401, "unauthorized");
		await expect(fetchEffectiveConfig()).rejects.toBeInstanceOf(StudioApiError);
	});
});

describe("fetchRoutines", () => {
	const routines: DeclaredRoutinesView = {
		repoConfigPath: "/repo/chit.config.json",
		routines: [
			{
				id: "deep",
				origin: "repo",
				mode: "converge",
				manifestPath: "flows/deep.json",
				manifest: {
					manifestDigest: "sha256:abc",
					participants: [
						{ id: "impl", agentId: "claude", session: "per_scope", filesystem: "write" },
					],
					requiredChecks: [{ command: "bun", args: ["test"] }],
				},
			},
		],
	};

	test("GETs /api/routines with the bearer token and maps a 200 to ok", async () => {
		const calls = mock(200, routines);
		const out = await fetchRoutines();
		expect(out).toEqual({ kind: "ok", routines });
		expect(calls[0]?.url).toBe("/api/routines");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
	});

	test("maps a 501 (no host config source) to unavailable", async () => {
		mock(501, "config view not available");
		expect(await fetchRoutines()).toEqual({ kind: "unavailable" });
	});

	test("maps a 422 load failure to the error outcome, not a throw", async () => {
		mock(422, "config load failed: /repo/chit.config.json: invalid JSON");
		const out = await fetchRoutines();
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.status).toBe(422);
			expect(out.error).toContain("chit.config.json");
		}
	});

	test("throws StudioApiError on 401 (auth failure is not a routines state)", async () => {
		mock(401, "unauthorized");
		await expect(fetchRoutines()).rejects.toBeInstanceOf(StudioApiError);
	});
});

describe("cancelLiveRun", () => {
	test("POSTs /api/live/cancel with the bearer token and the runId/source body", async () => {
		const calls = mock(200, { status: "requested", state: "running", signaled: true });
		const out = await cancelLiveRun("bg-1", "background");
		expect(out).toEqual({ kind: "requested", state: "running", signaled: true });
		expect(calls[0]?.url).toBe("/api/live/cancel");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ runId: "bg-1", source: "background" });
	});

	test("maps a 200 already-finished result", async () => {
		mock(200, { status: "already-finished", state: "completed" });
		expect(await cancelLiveRun("bg-1", "background")).toEqual({
			kind: "already-finished",
			state: "completed",
		});
	});

	test("maps a 404 to not-found", async () => {
		mock(404, "not found");
		expect(await cancelLiveRun("ghost", "background")).toEqual({ kind: "not-found" });
	});

	test("maps a non-2xx (422/501) to the error outcome with its status, not a throw", async () => {
		mock(422, "only background runs are cancellable from Studio");
		const out = await cancelLiveRun("fg-1", "foreground");
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.status).toBe(422);
			expect(out.error).toContain("background");
		}
	});

	test("propagates a transport failure as a throw (the caller's try/catch handles it)", async () => {
		// A fetch that only ever rejects (Promise<never>), so it needs the
		// through-unknown cast the typed mock above does not.
		globalThis.fetch = (async () => {
			throw new TypeError("network down");
		}) as unknown as typeof fetch;
		await expect(cancelLiveRun("bg-1", "background")).rejects.toBeInstanceOf(TypeError);
	});
});
