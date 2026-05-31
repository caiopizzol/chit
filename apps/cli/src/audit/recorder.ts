// AuditRecorder: turns a single run's lifecycle into persisted audit events +
// blobs via the node AuditStore. One recorder owns one runId. Callers drive it:
//   runStarted() once, fromTrace(e) for each runtime TraceEvent (step.*),
//   runCompleted() once. The adapter.call.* events are emitted by
//   wrapAdaptersWithAudit (wrap.ts), which holds a recorder and records each
//   adapter call's input/output blobs + usage at the call boundary.
//
// Best-effort by design: audit is OBSERVATIONAL and must never break a real run.
// Every store write is wrapped so a full disk, a permissions error, or a bad
// path degrades to "no audit for this event", not a failed agent run. The first
// swallowed error is kept on `lastError` for a caller/test to inspect.

import type {
	AdapterCallCompletedEvent,
	AdapterCallStartedEvent,
	AdapterCallStatus,
	AdapterEventEvent,
	AuditParticipantSnapshot,
	AuditSurface,
	RunStartedEvent,
	RunStatus,
	StepCompletedEvent,
	StepKind,
	StepStartedEvent,
} from "@chit/core";
import type {
	AdapterCallRequest,
	AdapterCallResult,
	AdapterEvent,
	TraceEvent,
} from "../runtime/types.ts";
import type { AuditStore, PruneOptions } from "./store.ts";

// Conservative default retention, applied opportunistically after an audited run
// completes. Audit transcripts hold full prompts/outputs (and can hold secrets),
// so they should not accumulate unbounded. A run is dropped if it exceeds ANY
// cap; the run just written is always kept (see AuditRecorder.prune).
export const DEFAULT_AUDIT_RETENTION: PruneOptions = {
	maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
	maxTotalBytes: 1024 * 1024 * 1024, // 1 GiB
	maxRuns: 1000,
};

export interface RunMeta {
	manifestId: string;
	cwd: string;
	surface: AuditSurface;
	scope?: string;
	manifestPath?: string;
	loopId?: string;
	iteration?: number;
	commandArgs?: string[];
	// Resolved per-participant config at run start, recorded on run.started so the
	// audit shows what the run ACTUALLY used (the registry can change afterward).
	participants?: Record<string, AuditParticipantSnapshot>;
}

// An opaque session payload ({ sessionId } / { threadId }) rendered to a stable
// string handle for cross-referencing resume chains. Not parsed by audit.
function sessionRef(session: unknown): string | undefined {
	if (session === undefined || session === null) return undefined;
	try {
		return JSON.stringify(session);
	} catch {
		return undefined;
	}
}

export class AuditRecorder {
	lastError: Error | undefined;

	constructor(
		private readonly store: AuditStore,
		readonly runId: string,
		private readonly meta: RunMeta,
		private readonly now: () => number = Date.now,
	) {}

	private ts(): string {
		return new Date(this.now()).toISOString();
	}

	// Run every store write through here: audit is observational and must never
	// throw into the run. The first failure is retained for inspection.
	private safe(fn: () => void): void {
		try {
			fn();
		} catch (e) {
			if (!this.lastError) this.lastError = e instanceof Error ? e : new Error(String(e));
		}
	}

	runStarted(): void {
		this.safe(() => {
			this.store.openRun(this.runId);
			const ev: RunStartedEvent = {
				type: "run.started",
				runId: this.runId,
				ts: this.ts(),
				manifestId: this.meta.manifestId,
				cwd: this.meta.cwd,
				surface: this.meta.surface,
			};
			if (this.meta.scope !== undefined) ev.scope = this.meta.scope;
			if (this.meta.manifestPath !== undefined) ev.manifestPath = this.meta.manifestPath;
			if (this.meta.loopId !== undefined) ev.loopId = this.meta.loopId;
			if (this.meta.iteration !== undefined) ev.iteration = this.meta.iteration;
			if (this.meta.commandArgs !== undefined) ev.commandArgs = this.meta.commandArgs;
			if (this.meta.participants !== undefined) ev.participants = this.meta.participants;
			this.store.appendEvent(this.runId, ev);
		});
	}

	// Step lifecycle. Called either from a runtime TraceEvent (executeManifest,
	// via fromTrace) or directly (the MCP stepwise engine, which has StepRecords,
	// not TraceEvents). step.* carry framing/timing + the step's output blob; the
	// prompt/input blob lives on the adapter.call.* events.
	stepStarted(
		stepId: string,
		kind: StepKind,
		opts: { participantId?: string; agentId?: string; session?: string } = {},
	): void {
		this.safe(() => {
			const ev: StepStartedEvent = {
				type: "step.started",
				runId: this.runId,
				ts: this.ts(),
				stepId,
				kind,
			};
			if (opts.participantId !== undefined) ev.participantId = opts.participantId;
			if (opts.agentId !== undefined) ev.agentId = opts.agentId;
			if (opts.session !== undefined) ev.session = opts.session;
			this.store.appendEvent(this.runId, ev);
		});
	}

	// output is captured verbatim as a content-addressed blob (a call step's
	// output shares the blob its adapter.call.completed already wrote).
	stepCompleted(stepId: string, durationMs: number, output: string): void {
		this.safe(() => {
			const ev: StepCompletedEvent = {
				type: "step.completed",
				runId: this.runId,
				ts: this.ts(),
				stepId,
				durationMs,
				outputBlob: this.store.writeBlob(this.runId, output),
			};
			this.store.appendEvent(this.runId, ev);
		});
	}

	// A cancelled step is recorded as step.failed with its cancellation reason:
	// the schema has no distinct step.cancelled, and the adapter.call.completed
	// for a cancelled call separately carries status "cancelled".
	stepFailed(stepId: string, error: string, durationMs: number): void {
		this.safe(() => {
			this.store.appendEvent(this.runId, {
				type: "step.failed",
				runId: this.runId,
				ts: this.ts(),
				stepId,
				error,
				durationMs,
			});
		});
	}

	// Map a runtime TraceEvent to the step.* methods (executeManifest path).
	fromTrace(e: TraceEvent): void {
		if (e.type === "step.started") {
			this.stepStarted(e.stepId, e.kind, {
				participantId: e.participantId,
				agentId: e.agentId,
				session: e.session,
			});
		} else if (e.type === "step.completed") {
			this.stepCompleted(e.stepId, e.durationMs, e.output);
		} else if (e.type === "step.failed") {
			this.stepFailed(e.stepId, e.error, e.durationMs);
		}
	}

	adapterCallStarted(req: AdapterCallRequest): void {
		this.safe(() => {
			const inputBlob = this.store.writeBlob(this.runId, req.input);
			const ev: AdapterCallStartedEvent = {
				type: "adapter.call.started",
				runId: this.runId,
				ts: this.ts(),
				stepId: req.stepId,
				participantId: req.participantId,
				agentId: req.agentId,
				cwd: req.cwd,
				inputBlob,
			};
			const prior = sessionRef(req.session);
			if (prior !== undefined) ev.priorSessionRef = prior;
			this.store.appendEvent(this.runId, ev);
		});
	}

	// One intra-call adapter event (a raw CLI event line, e.g. Codex JSONL). The
	// raw body is blobbed; the event line carries only the eventType + a ref, so
	// the stream stays inspectable without bloating events.jsonl.
	adapterEvent(stepId: string, event: AdapterEvent): void {
		this.safe(() => {
			const rawBlob = this.store.writeBlob(this.runId, event.raw);
			const ev: AdapterEventEvent = {
				type: "adapter.event",
				runId: this.runId,
				ts: this.ts(),
				stepId,
				eventType: event.type,
				rawBlob,
			};
			this.store.appendEvent(this.runId, ev);
		});
	}

	// On success, body is the agent output; on a failed/cancelled call, the error
	// text (so the failed call still has an inspectable blob, as the schema
	// requires an outputBlob).
	adapterCallCompleted(
		req: AdapterCallRequest,
		result: AdapterCallResult | undefined,
		durationMs: number,
		status: AdapterCallStatus,
		body: string,
	): void {
		this.safe(() => {
			const outputBlob = this.store.writeBlob(this.runId, body);
			const ev: AdapterCallCompletedEvent = {
				type: "adapter.call.completed",
				runId: this.runId,
				ts: this.ts(),
				stepId: req.stepId,
				outputBlob,
				durationMs,
				status,
			};
			const next = sessionRef(result?.session);
			if (next !== undefined) ev.newSessionRef = next;
			if (result?.usage !== undefined) ev.usage = result.usage;
			this.store.appendEvent(this.runId, ev);
		});
	}

	runCompleted(status: RunStatus, durationMs: number): void {
		this.safe(() => {
			this.store.appendEvent(this.runId, {
				type: "run.completed",
				runId: this.runId,
				ts: this.ts(),
				status,
				durationMs,
			});
		});
	}

	// Opportunistic retention: bound the audit store after THIS run is fully
	// written. Always keeps this run (a fresh run can be the newest yet larger
	// than maxTotalBytes). Best-effort and INDEPENDENT of audit-write success: it
	// must not touch lastError (which gates the run<->audit link), so a prune
	// failure never withholds a link to a transcript that was actually written.
	// Call only at a terminal point, never while steps may still append.
	prune(config: PruneOptions = DEFAULT_AUDIT_RETENTION): void {
		try {
			this.store.prune({ ...config, keep: [this.runId] });
		} catch {
			// retention is hygiene, not correctness; swallow.
		}
	}
}
