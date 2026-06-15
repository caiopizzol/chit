// Human-facing rendering for the three read surfaces: the routine list, the
// inspect view, and the trace receipt. Pure string-in/string-out so they are
// trivially testable and carry no IO. These ARE the onboarding layer -- if a
// reader can answer "what is this, what does it need, what will run, what
// happened" from here, the product model is working.

import type { ConvergeReceipt } from "./converge.ts";
import type { FlowReceipt } from "./flow.ts";
import { effectiveCallTimeoutMs, effectiveRunTimeoutMs, isComposition, isSandboxed, kindLabel } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import type { RunReceipt } from "./run.ts";

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortDigest(d: string): string {
	return d.length > 19 ? `${d.slice(0, 19)}…` : d;
}

// Render an effective timeout (ms) as a minutes label, or "none" when unbounded.
function minutesLabel(ms: number | undefined): string {
	return ms === undefined ? "none" : `${ms / 60_000}m`;
}

// A step/iteration start offset for the timeline, with a trailing gap. Omitted for
// legacy receipts written before per-step timestamps existed (their startedAt is
// absent), so `chit trace` stays readable for older runs instead of showing +NaNms.
function startOffset(startedAt: number | undefined, runStart: number): string {
	return typeof startedAt === "number" ? `+${startedAt - runStart}ms  ` : "";
}

// A call step's label, including the resolved binding it actually ran on (adapter, plus
// model when not the default) so trace is an audit record. Legacy receipts without a
// binding show just the call.
function callLabel(s: { participant?: string; adapter?: string; model?: string }): string {
	const base = `call ${s.participant}`;
	if (s.adapter === undefined) return base;
	return `${base} (${s.adapter}${s.model !== undefined && s.model !== "default" ? `:${s.model}` : ""})`;
}

// A one-line preview of an `ask` question for inspect (questions are often multi-line,
// e.g. they embed {{ steps.plan.output }}); collapse whitespace and clip.
function askPreview(q: string): string {
	const flat = q.replace(/\s+/g, " ").trim();
	return flat.length > 50 ? `"${flat.slice(0, 49)}…"` : `"${flat}"`;
}

export interface RoutineListItem {
	id: string;
	kind: string;
	description?: string;
}

export function formatRoutineList(items: RoutineListItem[]): string {
	if (items.length === 0) return "No routines configured. Add some under `routines` in chit.config.json.";
	const w = Math.max(...items.map((i) => i.id.length));
	const lines = items.map(
		(i) => `  ${pad(i.id, w)}  ${pad(i.kind, 12)}  ${i.description ?? ""}`.trimEnd(),
	);
	return [`routines (${items.length}):`, ...lines].join("\n");
}

export function formatInspect(routine: ResolvedRoutine): string {
	const m = routine.manifest;
	const out: string[] = [];
	out.push(`${routine.id}  (${kindLabel(m)})`);
	if (routine.description) out.push(routine.description);
	out.push("");

	const inputNames = Object.keys(m.inputs);
	if (inputNames.length > 0) {
		const w = Math.max(...inputNames.map((n) => n.length));
		out.push("inputs:");
		for (const [name, spec] of Object.entries(m.inputs)) {
			const req = spec.required ? "required" : "optional";
			out.push(`  ${pad(name, w)}  ${pad(req, 8)}  ${spec.description ?? ""}`.trimEnd());
		}
		out.push("");
	} else {
		out.push("inputs: none");
		out.push("");
	}

	if (isComposition(m)) {
		out.push("steps:");
		m.steps.forEach((s, i) => {
			if (s.kind === "ask") {
				out.push(`  ${i + 1}. ${pad(s.id, 10)} ask  ${askPreview(s.ask)}`.trimEnd());
				return;
			}
			if (s.kind !== "routine") return;
			const ins = Object.keys(s.inputs);
			out.push(`  ${i + 1}. ${pad(s.id, 10)} -> ${pad(s.routine, 22)}${ins.length ? `inputs: ${ins.join(", ")}` : ""}`.trimEnd());
		});
		out.push("");
		// A composition has no direct calls, so only the whole-flow wall-time bound applies.
		out.push(`limits: whole run ${minutesLabel(effectiveRunTimeoutMs(m))}`);
		out.push("");
		out.push("note: runs each routine in order, passing outputs forward. A terminal sandboxed");
		out.push("      step (if any) writes only its own worktree; --apply writes the result back.");
		out.push("");
		out.push(`manifest: ${routine.manifestPath}`);
		out.push(`digest:   ${shortDigest(routine.digest)}`);
		return out.join("\n");
	}

	const pnames = Object.keys(m.participants);
	if (pnames.length > 0) {
		const pw = Math.max(...pnames.map((n) => n.length));
		out.push("participants:");
		for (const [id, p] of Object.entries(m.participants)) {
			const binding = routine.agents?.[p.agent];
			const agentCol =
				binding !== undefined
					? `${p.agent} -> ${binding.adapter}${binding.model && binding.model !== "default" ? ` (${binding.model})` : ""}`
					: p.agent;
			out.push(`  ${pad(id, pw)}  ${pad(agentCol, 22)}  filesystem: ${p.filesystem}`);
		}
		out.push("");
	}

	out.push("steps:");
	m.steps.forEach((s, i) => {
		const what =
			s.kind === "call"
				? `call ${s.call}`
				: s.kind === "format"
					? "format"
					: s.kind === "check"
						? `check: ${s.checks.map((c) => [c.command, ...c.args].join(" ")).join(", ")}`
						: s.kind === "ask"
							? `ask  ${askPreview(s.ask)}`
							: "routine";
		out.push(`  ${i + 1}. ${pad(s.id, 10)} ${what}`);
	});

	if (m.repeat !== undefined) {
		const mi = routine.defaults?.maxIterations ?? m.repeat.maxIterations;
		const cond = m.repeat.until === "checks-pass" ? "all checks pass" : `${m.repeat.until.step} == ${JSON.stringify(m.repeat.until.equals)}`;
		out.push(`loop:   repeat the steps until ${cond}${mi !== undefined ? `, max ${mi} iterations` : ""}`);
	} else if (m.output !== undefined) {
		out.push(`output: ${m.output}`);
	}

	// Make the time bounds legible. Both apply to an execution routine: the per-call
	// bound caps any single call or check, the whole-run bound caps the run's wall-time.
	out.push(`limits: per call ${minutesLabel(effectiveCallTimeoutMs(m))}, whole run ${minutesLabel(effectiveRunTimeoutMs(m))}`);

	if (isSandboxed(m)) {
		out.push("");
		out.push("note: runs in a git-worktree sandbox -- dry run by default (shows the diff,");
		out.push("      discards it); pass --apply to write a result back to your tree.");
	}
	out.push("");
	out.push(`manifest: ${routine.manifestPath}`);
	out.push(`digest:   ${shortDigest(routine.digest)}`);
	return out.join("\n");
}

export function formatTrace(r: RunReceipt | ConvergeReceipt | FlowReceipt): string {
	const out: string[] = [];
	out.push(`${r.runId}  ${r.routineId}  ${r.status}`);
	if (r.scope) out.push(`scope:    ${r.scope}`);
	out.push(`elapsed:  ${r.elapsedMs}ms`);
	out.push(`digest:   ${shortDigest(r.digest)}`);
	// A sandboxed run records the origin commit it started from (preflight guaranteed clean).
	if ("baseCommit" in r && r.baseCommit) out.push(`base:     ${r.baseCommit.slice(0, 12)}`);
	const inputKeys = Object.keys(r.inputs);

	if (r.policy === "flow") {
		out.push(`inputs:   ${inputKeys.length > 0 ? inputKeys.join(", ") : "none"}`);
		out.push("steps:");
		const w = Math.max(1, ...r.steps.map((s) => s.id.length));
		for (const s of r.steps) {
			// An ask gate has no sub-routine/sub-run -- show it as `ask` with a "-" run id.
			if (s.kind === "ask") {
				out.push(`  ${pad(s.id, w)}  -> ${pad("ask", 22)}  ${pad(s.status, 15)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms  -`);
			} else {
				out.push(`  ${pad(s.id, w)}  -> ${pad(s.routine, 22)}  ${pad(s.status, 15)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms  ${s.subRunId || "-"}`);
			}
		}
		if (r.applyError) out.push(`apply:    could not apply to your tree -- ${r.applyError}`);
		if (r.status === "failed" || r.status === "cancelled") out.push(`error:    ${r.error ?? "(unknown)"}`);
		return out.join("\n");
	}
	out.push(`inputs:   ${inputKeys.length > 0 ? inputKeys.join(", ") : "none"}`);

	if (r.policy === "converge") {
		// The exit condition this loop ran under, and the per-iteration verdict labelled for it:
		// checks-pass reports "checks passed/failed"; { step, equals } reports "condition met/not".
		// Legacy receipts (written before `until` existed) had only checks-pass; default to it.
		const until = r.until ?? "checks-pass";
		const untilLabel = until === "checks-pass" ? "checks-pass" : `${until.step} == ${JSON.stringify(until.equals)}`;
		const verdict = (met: boolean): string =>
			until === "checks-pass" ? (met ? "checks passed" : "checks failed") : met ? "condition met" : "condition not met";
		out.push(`iterations: ${r.iterations.length} (max ${r.maxIterations}); until: ${untilLabel}`);
		for (const it of r.iterations) {
			out.push(`  iteration ${it.n}  ${startOffset(it.startedAt, r.startedAt)}${verdict(it.allChecksPassed)}`);
			const w = Math.max(1, ...it.steps.map((s) => s.id.length));
			for (const s of it.steps) {
				const who = s.kind === "call" ? callLabel(s) : s.kind;
				let line = `    ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 9)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms`;
				if (s.checks) line += `  [${s.checks.map((c) => `${c.command}:${c.ok ? "ok" : "fail"}`).join(", ")}]`;
				out.push(line);
				if (s.error) out.push(`      error: ${s.error}`);
			}
		}
		if (r.sandbox?.diffStat) {
			out.push("changes:");
			for (const line of r.sandbox.diffStat.split("\n")) out.push(`  ${line}`);
		} else if (r.output !== undefined) {
			// A non-sandboxed loop produces no diff; its result is text, summarized (not dumped)
			// just like a one-shot's output -- the body was printed at run time.
			out.push(`output:   ${r.output.length} chars (printed at run time; not shown here)`);
		}
		if (r.applyError) out.push(`apply:    could not apply to your tree -- ${r.applyError}`);
		if (r.status === "failed" || r.status === "cancelled") out.push(`error:    ${r.error ?? "(unknown)"}`);
		return out.join("\n");
	}

	out.push("steps:");
	const w = Math.max(1, ...r.steps.map((s) => s.id.length));
	for (const s of r.steps) {
		const who = s.kind === "call" ? callLabel(s) : s.kind === "ask" ? "ask" : "format";
		out.push(`  ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 9)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms`);
	}
	if (r.status === "failed" || r.status === "cancelled") {
		out.push(`error:    ${r.error ?? "(unknown)"}`);
	} else if (r.output !== undefined) {
		// The receipt keeps the final output, but trace summarizes it -- the body was
		// printed at run time; this view is the audit record, not a transcript dump.
		out.push(`output:   ${r.output.length} chars (printed at run time; not shown here)`);
	}
	return out.join("\n");
}
