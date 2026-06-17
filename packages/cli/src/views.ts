// Human-facing rendering for the three read surfaces: the routine list, the
// inspect view, and the trace receipt. Pure string-in/string-out so they are
// trivially testable and carry no IO. These ARE the onboarding layer -- if a
// reader can answer "what is this, what does it need, what will run, what
// happened" from here, the product model is working.

import type { ConvergeReceipt } from "./converge.ts";
import { formatElapsed } from "./elapsed.ts";
import type { FlowReceipt } from "./flow.ts";
import {
	effectiveCallTimeoutMs,
	effectiveRunTimeoutMs,
	isComposition,
	isSandboxed,
	kindLabel,
	type RepeatCondition,
	type RepeatUntil,
} from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import type { RunReceipt } from "./run.ts";
import type { RunState } from "./runstate.ts";
import type { PatchStatus } from "./store.ts";

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

// Render a loop's exit condition for inspect/trace. `checksLabel` lets each caller phrase the
// checks-pass case to fit its sentence ("all checks pass" in inspect, "checks-pass" in trace);
// an `{ all: [...] }` reads as the conditions joined by AND.
function formatUntil(u: RepeatUntil, checksLabel: string): string {
	const cond = (c: RepeatCondition): string =>
		c === "checks-pass"
			? checksLabel
			: "path" in c
				? `${c.step}.${c.path} == ${JSON.stringify(c.equals)}`
				: `${c.step} == ${JSON.stringify(c.equals)}`;
	return typeof u === "object" && "all" in u ? u.all.map(cond).join(" AND ") : cond(u);
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
function bindingLabel(s: { adapter: string; model?: string; effort?: string }): string {
	const parts = [s.adapter];
	if (s.model !== undefined && s.model !== "default") parts[0] = `${s.adapter}:${s.model}`;
	if (s.effort !== undefined) parts.push(`effort=${s.effort}`);
	return parts.join(" ");
}

function callLabel(s: { participant?: string; adapter?: string; model?: string; effort?: string }): string {
	const base = `call ${s.participant}`;
	if (s.adapter === undefined) return base;
	return `${base} (${bindingLabel({ adapter: s.adapter, ...(s.model !== undefined && { model: s.model }), ...(s.effort !== undefined && { effort: s.effort }) })})`;
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
	const lines = items.map((i) => `  ${pad(i.id, w)}  ${pad(i.kind, 12)}  ${i.description ?? ""}`.trimEnd());
	return [`routines (${items.length}):`, ...lines].join("\n");
}

// Compact "how long ago" for the run history. The receipt stores absolute startedAt; the caller
// passes the elapsed-since value so this stays a pure render.
function ageLabel(ms: number): string {
	if (ms < 1000) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

// One row of the run history. Everything here is derived from a stored receipt plus the patch's
// lifecycle state (derived live from git). `patch` is "none" when the run stored no patch.
export interface RunListItem {
	runId: string;
	routineId: string;
	status: string;
	scope?: string;
	ageMs: number;
	inputs: Record<string, string>;
	patch: PatchStatus;
}

// A one-line preview of a run's primary (first) input VALUE, so two runs of the same routine are
// distinguishable in the history ("add a shout(name)..." vs "...whisper(name)..."). Whitespace is
// collapsed and the value clipped; any further inputs are noted as `+N`.
function inputPreview(inputs: Record<string, string>): string {
	const keys = Object.keys(inputs);
	const key = keys[0];
	if (key === undefined) return "-";
	const value = (inputs[key] ?? "").replace(/\s+/g, " ").trim();
	const clipped = value.length > 48 ? `${value.slice(0, 47)}…` : value || "-";
	return `${key}: ${clipped}${keys.length > 1 ? ` +${keys.length - 1}` : ""}`;
}

// The run history: the evidence Chit already stores, read back. Newest first. `scopeFilter` is
// only used to phrase the empty/header line; the caller does the filtering.
export function formatRunList(items: RunListItem[], scopeFilter?: string): string {
	if (items.length === 0) {
		return scopeFilter !== undefined
			? `No runs found for scope "${scopeFilter}".`
			: "No runs yet. Run a routine, then `chit runs` shows the history.";
	}
	const rows = [...items].sort((a, b) => a.ageMs - b.ageMs);
	const wId = Math.max(...rows.map((r) => r.runId.length));
	const wRoutine = Math.max(...rows.map((r) => r.routineId.length));
	const wStatus = Math.max(...rows.map((r) => r.status.length));
	const wScope = Math.max(5, ...rows.map((r) => (r.scope ?? "-").length));
	const wPatch = Math.max(0, ...rows.map((r) => (r.patch === "none" ? 0 : r.patch.length)));
	const lines = rows.map((r) => {
		const patch = pad(r.patch === "none" ? "" : r.patch, wPatch);
		return `  ${pad(r.runId, wId)}  ${pad(r.routineId, wRoutine)}  ${pad(r.status, wStatus)}  ${pad(r.scope ?? "-", wScope)}  ${pad(ageLabel(r.ageMs), 9)}  ${patch}  ${inputPreview(r.inputs)}`.trimEnd();
	});
	const header =
		scopeFilter !== undefined ? `runs in scope "${scopeFilter}" (${rows.length}):` : `runs (${rows.length}):`;
	return [header, ...lines].join("\n");
}

export interface LiveRunListItem {
	runId: string;
	routineId: string;
	pid: number;
	ageMs: number;
	cwd: string;
}

export function formatLiveRunList(items: LiveRunListItem[]): string {
	if (items.length === 0) return "No live runs.";
	const rows = [...items].sort((a, b) => a.ageMs - b.ageMs);
	const wId = Math.max(...rows.map((r) => r.runId.length));
	const wRoutine = Math.max(...rows.map((r) => r.routineId.length));
	const wPid = Math.max(3, ...rows.map((r) => String(r.pid).length));
	const lines = rows.map((r) =>
		`  ${pad(r.runId, wId)}  ${pad(r.routineId, wRoutine)}  pid ${pad(String(r.pid), wPid)}  ${pad(ageLabel(r.ageMs), 9)}  ${r.cwd}`.trimEnd(),
	);
	return [`live runs (${rows.length}):`, ...lines].join("\n");
}

// A single run's state, read back for `chit status`. The header leads with the phase (and the
// receipt status once finished); the detail lines fit the phase -- an active run shows where it
// is and how to follow it, a finished run shows the receipt facts and points at `chit trace`.
export function formatRunStatus(s: RunState): string {
	const head = s.phase === "finished" && s.status !== undefined ? `${s.phase}: ${s.status}` : s.phase;
	const out = [`${s.runId}  ${s.routineId ?? "-"}  ${head}`];
	if (s.scope) out.push(`scope:    ${s.scope}`);
	if (!s.done) {
		if (s.pid !== undefined) out.push(`pid:      ${s.pid}`);
		out.push(`elapsed:  ${formatElapsed(s.elapsedMs)}`);
		if (s.cwd) out.push(`cwd:      ${s.cwd}`);
		out.push(`follow:   chit wait ${s.runId}`);
		return out.join("\n");
	}
	out.push(`elapsed:  ${s.elapsedMs}ms`);
	if (s.baseCommit) out.push(`base:     ${s.baseCommit.slice(0, 12)}`);
	if (s.patch !== undefined) out.push(`patch:    ${s.patch}`);
	if (s.applied) out.push("applied:  yes");
	if (s.applyError) out.push(`apply:    could not apply to your tree -- ${s.applyError}`);
	if (s.error) out.push(`error:    ${s.error}`);
	if (s.phase === "finished") out.push(`trace:    chit trace ${s.runId}`);
	return out.join("\n");
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
			out.push(
				`  ${i + 1}. ${pad(s.id, 10)} -> ${pad(s.routine, 22)}${ins.length ? `inputs: ${ins.join(", ")}` : ""}`.trimEnd(),
			);
		});
		out.push("");
		// A composition has no direct calls, so only the whole-flow wall-time bound applies.
		out.push(`limits: whole run ${minutesLabel(effectiveRunTimeoutMs(m))}`);
		out.push("");
		out.push("note: runs each routine in order, passing outputs forward. A terminal sandboxed");
		out.push("      step (if any) writes only its own worktree; review the diff, then `chit apply`.");
		out.push("");
		out.push(`manifest: ${routine.manifestPath}`);
		out.push(`digest:   ${shortDigest(routine.digest)}`);
		return out.join("\n");
	}

	const pnames = Object.keys(m.participants);
	if (pnames.length > 0) {
		const pw = Math.max(...pnames.map((n) => n.length));
		// The routine config calls these "agents" (each bound to a root profile); the runtime
		// type still calls them participants. Show the user-facing name here.
		out.push("agents:");
		for (const [id, p] of Object.entries(m.participants)) {
			const binding = routine.agents?.[p.agent];
			const agentCol = binding !== undefined ? `${p.agent} -> ${bindingLabel(binding)}` : p.agent;
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
		const cond = formatUntil(m.repeat.until, "all checks pass");
		out.push(`loop:   repeat the steps until ${cond}${mi !== undefined ? `, max ${mi} iterations` : ""}`);
	} else if (m.output !== undefined) {
		out.push(`output: ${m.output}`);
	}

	// Make the time bounds legible. Both apply to an execution routine: the per-call
	// bound caps any single call or check, the whole-run bound caps the run's wall-time.
	out.push(
		`limits: per call ${minutesLabel(effectiveCallTimeoutMs(m))}, whole run ${minutesLabel(effectiveRunTimeoutMs(m))}`,
	);

	if (m.changePolicy !== undefined) {
		out.push("");
		out.push("change policy:");
		if (m.changePolicy.allowedChangedPaths !== undefined) {
			out.push(`  allowed: ${m.changePolicy.allowedChangedPaths.join(", ")}`);
		}
		if (m.changePolicy.deniedChangedPaths !== undefined) {
			out.push(`  denied:  ${m.changePolicy.deniedChangedPaths.join(", ")}`);
		}
	}

	if (isSandboxed(m)) {
		out.push("");
		out.push("note: runs in a git-worktree sandbox -- dry run by default (shows the diff,");
		out.push("      discards it); review the diff, then `chit apply <run-id>` to apply it.");
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
				out.push(
					`  ${pad(s.id, w)}  -> ${pad("ask", 22)}  ${pad(s.status, 15)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms  -`,
				);
			} else {
				out.push(
					`  ${pad(s.id, w)}  -> ${pad(s.routine, 22)}  ${pad(s.status, 15)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms  ${s.subRunId || "-"}`,
				);
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
		const untilLabel = formatUntil(until, "checks-pass");
		const verdict = (met: boolean): string => {
			if (until === "checks-pass") return met ? "checks passed" : "checks failed";
			if (typeof until === "object" && "all" in until) return met ? "all conditions met" : "not yet";
			return met ? "condition met" : "condition not met";
		};
		out.push(`iterations: ${r.iterations.length} (max ${r.maxIterations}); until: ${untilLabel}`);
		for (const it of r.iterations) {
			out.push(`  iteration ${it.n}  ${startOffset(it.startedAt, r.startedAt)}${verdict(it.allChecksPassed)}`);
			const w = Math.max(1, ...it.steps.map((s) => s.id.length));
			for (const s of it.steps) {
				const who = s.kind === "call" ? callLabel(s) : s.kind;
				let line = `    ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 9)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms`;
				if (s.checks) line += `  [${s.checks.map((c) => `${c.command}:${c.ok ? "ok" : "fail"}`).join(", ")}]`;
				out.push(line);
				if (s.json !== undefined) out.push(`      json: ${JSON.stringify(s.json)}`);
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
		if (r.changePolicyViolation) {
			out.push("change policy violation:");
			if (r.failureKind) out.push(`  kind: ${r.failureKind}`);
			if (r.changePolicyViolation.allowed) out.push(`  allowed: ${r.changePolicyViolation.allowed.join(", ")}`);
			if (r.changePolicyViolation.denied) out.push(`  denied:  ${r.changePolicyViolation.denied.join(", ")}`);
			out.push(`  unexpected: ${r.changePolicyViolation.unexpectedFiles.join(", ")}`);
		}
		if (r.applyError) out.push(`apply:    could not apply to your tree -- ${r.applyError}`);
		if (r.status === "failed" || r.status === "cancelled") out.push(`error:    ${r.error ?? "(unknown)"}`);
		return out.join("\n");
	}

	out.push("steps:");
	const w = Math.max(1, ...r.steps.map((s) => s.id.length));
	for (const s of r.steps) {
		const who = s.kind === "call" ? callLabel(s) : s.kind === "ask" ? "ask" : "format";
		out.push(
			`  ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 9)}  ${startOffset(s.startedAt, r.startedAt)}${s.elapsedMs}ms`,
		);
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

// The full stored content of a receipt, for `chit trace --full`: the input VALUES, the final
// output, and the stored patch when there is one. All of this already sits on disk in plaintext;
// --full only DISPLAYS it (it reveals nothing the compact view collected differently). Kept
// separate so the compact `formatTrace` audit stays the default.
export function formatReceiptBodies(
	r: RunReceipt | ConvergeReceipt | FlowReceipt,
	patch?: string,
	debugPatch?: string,
): string {
	const indentBlock = (s: string): string =>
		s
			.split("\n")
			.map((l) => `  ${l}`)
			.join("\n");
	const out: string[] = [];
	const inputKeys = Object.keys(r.inputs);
	if (inputKeys.length > 0) {
		out.push("inputs:");
		for (const k of inputKeys) out.push(`  ${k}: ${r.inputs[k] ?? ""}`);
	}
	if ("output" in r && typeof r.output === "string" && r.output.length > 0) {
		out.push("output:");
		out.push(indentBlock(r.output));
	}
	const stepOutputs: Array<{ label: string; body: string }> = [];
	if (r.policy === "one-shot") {
		for (const s of r.steps) {
			if (s.output) stepOutputs.push({ label: s.id, body: s.output });
		}
	} else if (r.policy === "converge") {
		for (const it of r.iterations) {
			for (const s of it.steps) {
				if (s.output) stepOutputs.push({ label: `iteration ${it.n} / ${s.id}`, body: s.output });
				for (const check of s.checks ?? []) {
					if (check.output)
						stepOutputs.push({ label: `iteration ${it.n} / ${s.id} / ${check.command}`, body: check.output });
				}
			}
		}
	}
	if (stepOutputs.length > 0) {
		out.push("step outputs:");
		for (const entry of stepOutputs) {
			out.push(`  ${entry.label}:`);
			out.push(indentBlock(entry.body));
		}
	}
	if (patch !== undefined && patch.trim() !== "") {
		out.push("patch:");
		out.push(indentBlock(patch));
	}
	if (debugPatch !== undefined && debugPatch.trim() !== "") {
		out.push("debug patch (not applyable):");
		out.push(indentBlock(debugPatch));
	}
	return out.join("\n");
}
