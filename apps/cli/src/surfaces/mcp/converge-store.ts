import type { ConvergeSession } from "./converge-engine.ts";

// Holds active MCP converge sessions plus an idle-eviction policy, mirroring
// RunStore (see run-store.ts). Lives apart from server.ts so the sweep is
// unit-testable without booting the stdio server. The in-memory session map
// would otherwise grow without bound (every chit_converge_start adds; nothing
// removed).
//
// Eviction is IDLE-based: a session is touched on create, on every successful
// lookup, and again after an iteration settles. sweep() (called on
// chit_converge_start) drops only sessions idle past the TTL that have NO
// in-flight iteration (session.active set) -- so a long-running iteration is
// never evicted out from under chit_converge_status/cancel/trace. The durable
// loop log persists regardless of eviction; only the in-memory session (with its
// execute boundary and prior_review) is dropped. `now` is passed in to keep the
// logic pure/testable.

const ONE_HOUR_MS = 60 * 60 * 1000;

export class ConvergeStore {
	private readonly sessions = new Map<string, ConvergeSession>();
	private readonly lastTouched = new Map<string, number>();

	constructor(private readonly ttlMs: number = ONE_HOUR_MS) {}

	add(session: ConvergeSession, now: number): void {
		this.sessions.set(session.loopId, session);
		this.lastTouched.set(session.loopId, now);
	}

	// Fetch a session and refresh its idle timer. Undefined if absent (or evicted).
	get(loopId: string, now: number): ConvergeSession | undefined {
		const session = this.sessions.get(loopId);
		if (session) this.lastTouched.set(loopId, now);
		return session;
	}

	// Refresh the idle timer without fetching -- used after an iteration settles,
	// so a long iteration that finishes just past the TTL is not swept immediately.
	touch(loopId: string, now: number): void {
		if (this.sessions.has(loopId)) this.lastTouched.set(loopId, now);
	}

	// All current sessions, in insertion (creation) order. Read-only: chit_status
	// enumerates live loops through this WITHOUT touching idle timers, so a status
	// poll never keeps a session alive (that would defeat idle eviction).
	list(): ConvergeSession[] {
		return [...this.sessions.values()];
	}

	// Evict sessions idle longer than the TTL that have no in-flight iteration.
	// Returns the evicted loop ids. Deletes from both maps so no timestamp leaks.
	sweep(now: number): string[] {
		const evicted: string[] = [];
		for (const [loopId, session] of this.sessions) {
			const idleMs = now - (this.lastTouched.get(loopId) ?? now);
			if (idleMs <= this.ttlMs) continue;
			if (session.active !== undefined) continue; // never evict an in-flight loop
			this.sessions.delete(loopId);
			this.lastTouched.delete(loopId);
			evicted.push(loopId);
		}
		return evicted;
	}

	get size(): number {
		return this.sessions.size;
	}
}
