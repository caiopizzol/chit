import {
	type AuditSurface,
	type NormalizedManifest,
	type NormalizedRegistry,
	resolveParticipantSnapshots,
} from "@chit-run/core";
import { buildAdapter } from "../adapters/factory.ts";
import { AuditRecorder } from "../audit/recorder.ts";
import { AuditStore } from "../audit/store.ts";
import { wrapAdaptersWithAudit } from "../audit/wrap.ts";
import { executeManifest } from "../runtime/execute.ts";
import type { AdapterMap, RunResult, TraceEvent } from "../runtime/types.ts";
import { wrapAdaptersWithSessions } from "../sessions/coordinator.ts";
import { defaultSessionDir, FileSessionStore } from "../sessions/store.ts";
import type { SessionStore } from "../sessions/types.ts";

export interface RunOnceOptions {
	inputs: Record<string, unknown>;
	registry: NormalizedRegistry;
	invocationCwd: string;
	// Audit surface tag: "cli" for the CLI run command, "mcp" for a background
	// one-shot run launched over MCP. (Converge runs keep their own "converge".)
	surface: AuditSurface;
	scope?: string;
	audit?: boolean;
	signal?: AbortSignal;
	onTrace?: (e: TraceEvent) => void;
	// Test seams (production omits): pre-built adapters instead of building them
	// from the registry, and injectable stores so a run touches no real state dir.
	adapters?: AdapterMap;
	auditStore?: AuditStore;
	sessionStore?: SessionStore;
	now?: () => number;
}

export interface RunOnceResult {
	ok: boolean;
	output?: string;
	failedStep?: string;
	error?: string;
	// The audit run id, present ONLY when audit was on AND every audit write
	// succeeded, so it always points at a complete, readable transcript.
	auditRunId?: string;
}

// Run a manifest ONCE to completion (a single DAG pass via executeManifest) with
// the same audited + session-wrapped adapter stack the CLI `chit run` builds.
// This is the reusable one-shot execution primitive: a background one-shot job
// and the CLI run path both use it, so a one-shot run records its audit and
// finishes WITHOUT pretending to be a converge loop. Loop convergence stays in
// the converge driver; this never loops.
export async function runManifestOnce(
	manifest: NormalizedManifest,
	opts: RunOnceOptions,
): Promise<RunOnceResult> {
	const now = opts.now ?? Date.now;

	// One base adapter per unique agent (unless tests inject a ready map).
	let effective: AdapterMap;
	if (opts.adapters) {
		effective = opts.adapters;
	} else {
		const adapters: AdapterMap = {};
		for (const p of Object.values(manifest.participants)) {
			if (!(p.agent in adapters)) {
				const agent = opts.registry.agents[p.agent];
				if (!agent) continue; // unknown agents are validated before this is called
				adapters[p.agent] = buildAdapter(agent);
			}
		}
		effective = adapters;
	}

	let recorder: AuditRecorder | undefined;
	const startedAt = now();
	if (opts.audit) {
		recorder = new AuditRecorder(opts.auditStore ?? new AuditStore(), crypto.randomUUID(), {
			manifestId: manifest.id,
			cwd: opts.invocationCwd,
			surface: opts.surface,
			...(opts.scope !== undefined && { scope: opts.scope }),
			participants: resolveParticipantSnapshots(manifest, opts.registry),
		});
		recorder.runStarted();
		effective = wrapAdaptersWithAudit(effective, recorder);
	}
	if (opts.scope !== undefined) {
		const store = opts.sessionStore ?? new FileSessionStore(defaultSessionDir());
		effective = wrapAdaptersWithSessions(effective, manifest, opts.registry, opts.scope, store);
	}

	// --trace-style observation and the audit recorder both ride onTrace.
	const recordTrace = recorder;
	const onTrace =
		opts.onTrace || recordTrace
			? (e: TraceEvent) => {
					opts.onTrace?.(e);
					recordTrace?.fromTrace(e);
				}
			: undefined;

	let result: RunResult;
	try {
		result = await executeManifest(manifest, {
			inputs: opts.inputs,
			adapters: effective,
			invocationCwd: opts.invocationCwd,
			...(onTrace && { onTrace }),
			...(opts.signal && { signal: opts.signal }),
		});
	} catch (e) {
		// A setup/abort failure (RuntimeError) — record the run as failed and surface
		// the reason. The audit ref is withheld below if any write failed.
		recorder?.runCompleted("failed", now() - startedAt);
		recorder?.prune();
		const auditRunId = recorder && recorder.lastError === undefined ? recorder.runId : undefined;
		return { ok: false, error: (e as Error).message, ...(auditRunId && { auditRunId }) };
	}

	recorder?.runCompleted(result.ok ? "ok" : "failed", now() - startedAt);
	recorder?.prune();
	const auditRunId = recorder && recorder.lastError === undefined ? recorder.runId : undefined;

	if (result.ok) {
		return { ok: true, output: result.output, ...(auditRunId && { auditRunId }) };
	}
	return {
		ok: false,
		failedStep: result.failedStep,
		error: result.error,
		...(auditRunId && { auditRunId }),
	};
}
