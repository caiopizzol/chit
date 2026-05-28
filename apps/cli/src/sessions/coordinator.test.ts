import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedManifest } from "@chit/core";
import { parseManifest, parseRegistry } from "@chit/core";
import type {
	AdapterCallRequest,
	AdapterCallResult,
	AdapterMap,
	RuntimeAdapter,
} from "../runtime/types.ts";
import { wrapAdaptersWithSessions } from "./coordinator.ts";
import { FileSessionStore } from "./store.ts";

// Records every call it receives and emits an incrementing session payload.
// Used to assert that the coordinator injects prior session, captures the
// new session, and persists across multiple calls.
class EchoSessionAdapter implements RuntimeAdapter {
	public calls: AdapterCallRequest[] = [];
	private counter = 0;

	call(req: AdapterCallRequest): Promise<AdapterCallResult> {
		this.calls.push(req);
		this.counter++;
		return Promise.resolve({
			output: `call-${this.counter}: saw session=${JSON.stringify(req.session ?? null)}`,
			session: { tick: this.counter },
		});
	}
}

// Pass-through that never produces a session. Used to assert the coordinator
// does NOT write anything when the adapter returns no session.
class StatelessAdapter implements RuntimeAdapter {
	public calls: AdapterCallRequest[] = [];

	call(req: AdapterCallRequest): Promise<AdapterCallResult> {
		this.calls.push(req);
		return Promise.resolve({ output: "no session here" });
	}
}

const STATEFUL_MANIFEST = {
	schema: 1,
	id: "stateful-test",
	description: "test",
	inputs: { q: { type: "string" } },
	requires: { can_show_markdown: true },
	participants: {
		alpha: { agent: "codex", role: "advisor A", session: "per_scope" },
		beta: { agent: "codex", role: "advisor B", session: "per_scope" },
	},
	steps: {
		s1: { call: "alpha", prompt: "{{ inputs.q }}" },
		s2: { call: "beta", prompt: "{{ inputs.q }}" },
		out: { format: "{{ steps.s1.output }} | {{ steps.s2.output }}" },
	},
	output: "out",
};

const STATELESS_MANIFEST = {
	...STATEFUL_MANIFEST,
	id: "stateless-test",
	participants: {
		alpha: { agent: "codex", role: "advisor A", session: "stateless" },
	},
	steps: {
		s1: { call: "alpha", prompt: "{{ inputs.q }}" },
		out: { format: "{{ steps.s1.output }}" },
	},
};

let TMPDIR: string;
let manifest: NormalizedManifest;
let statelessManifest: NormalizedManifest;
const registry = parseRegistry(undefined);

beforeEach(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "handoff-coord-"));
	manifest = parseManifest(STATEFUL_MANIFEST);
	statelessManifest = parseManifest(STATELESS_MANIFEST);
});

afterEach(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

function baseReq(participantId: string, stepId: string): AdapterCallRequest {
	return {
		participantId,
		agentId: "codex",
		stepId,
		input: "hi",
		cwd: TMPDIR,
	};
}

describe("wrapAdaptersWithSessions: round trip", () => {
	test("first call has no prior session; subsequent calls receive the saved one", async () => {
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);
		const adapters: AdapterMap = { codex: inner };
		const wrapped = wrapAdaptersWithSessions(adapters, manifest, registry, "test-scope", store);

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[0]?.session).toBeUndefined();

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[1]?.session).toEqual({ tick: 1 });

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[2]?.session).toEqual({ tick: 2 });
	});

	test("different participants have independent sessions even when sharing an agent", async () => {
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);
		const adapters: AdapterMap = { codex: inner };
		const wrapped = wrapAdaptersWithSessions(adapters, manifest, registry, "scope-x", store);

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		await wrapped.codex?.call(baseReq("beta", "s2"));
		expect(inner.calls[0]?.session).toBeUndefined();
		expect(inner.calls[1]?.session).toBeUndefined();

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		await wrapped.codex?.call(baseReq("beta", "s2"));
		expect(inner.calls[2]?.session).toEqual({ tick: 1 });
		expect(inner.calls[3]?.session).toEqual({ tick: 2 });
	});
});

describe("wrapAdaptersWithSessions: scope isolation", () => {
	test("different scopes don't share sessions", async () => {
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);
		const adaptersA = wrapAdaptersWithSessions({ codex: inner }, manifest, registry, "A", store);
		const adaptersB = wrapAdaptersWithSessions({ codex: inner }, manifest, registry, "B", store);

		await adaptersA.codex?.call(baseReq("alpha", "s1"));
		await adaptersB.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[0]?.session).toBeUndefined();
		expect(inner.calls[1]?.session).toBeUndefined();
	});

	test("different manifestIds don't share sessions", async () => {
		const otherManifest = parseManifest({ ...STATEFUL_MANIFEST, id: "other-id" });
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);

		const a = wrapAdaptersWithSessions({ codex: inner }, manifest, registry, "same", store);
		const b = wrapAdaptersWithSessions({ codex: inner }, otherManifest, registry, "same", store);

		await a.codex?.call(baseReq("alpha", "s1"));
		await b.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[0]?.session).toBeUndefined();
		expect(inner.calls[1]?.session).toBeUndefined();
	});
});

describe("wrapAdaptersWithSessions: non-per_scope participants", () => {
	test("stateless participants are not wrapped (session never injected)", async () => {
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);
		const adapters: AdapterMap = { codex: inner };
		const wrapped = wrapAdaptersWithSessions(
			adapters,
			statelessManifest,
			registry,
			"any-scope",
			store,
		);

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		await wrapped.codex?.call(baseReq("alpha", "s1"));
		// Both calls saw undefined session because the participant is stateless
		// and the coordinator did not engage.
		expect(inner.calls[0]?.session).toBeUndefined();
		expect(inner.calls[1]?.session).toBeUndefined();
	});

	test("adapter returning no session writes nothing", async () => {
		const inner = new StatelessAdapter();
		const store = new FileSessionStore(TMPDIR);
		const wrapped = wrapAdaptersWithSessions({ codex: inner }, manifest, registry, "x", store);

		await wrapped.codex?.call(baseReq("alpha", "s1"));
		// Confirm a subsequent call also sees no prior session, because none was saved.
		await wrapped.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[1]?.session).toBeUndefined();
	});
});

describe("wrapAdaptersWithSessions: fingerprint invalidation", () => {
	test("a role change invalidates the prior session", async () => {
		const inner = new EchoSessionAdapter();
		const store = new FileSessionStore(TMPDIR);

		const before = wrapAdaptersWithSessions({ codex: inner }, manifest, registry, "s", store);
		await before.codex?.call(baseReq("alpha", "s1"));
		expect(inner.calls[0]?.session).toBeUndefined();

		// Same manifest id, same participant id, but the role text changed.
		const mutated = parseManifest({
			...STATEFUL_MANIFEST,
			participants: {
				...STATEFUL_MANIFEST.participants,
				alpha: {
					...STATEFUL_MANIFEST.participants.alpha,
					role: "advisor A (revised)",
				},
			},
		});
		const after = wrapAdaptersWithSessions({ codex: inner }, mutated, registry, "s", store);
		await after.codex?.call(baseReq("alpha", "s1"));
		// New fingerprint => empty slot => prior session not injected.
		expect(inner.calls[1]?.session).toBeUndefined();
	});
});
