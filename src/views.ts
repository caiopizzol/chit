// Human-facing rendering for the three read surfaces: the routine list, the
// inspect view, and the trace receipt. Pure string-in/string-out so they are
// trivially testable and carry no IO. These ARE the onboarding layer -- if a
// reader can answer "what is this, what does it need, what will run, what
// happened" from here, the product model is working.

import type { ConvergeReceipt } from "./converge.ts";
import type { Manifest } from "./manifest.ts";
import type { ResolvedRoutine } from "./routine.ts";
import type { RunReceipt } from "./run.ts";

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortDigest(d: string): string {
	return d.length > 19 ? `${d.slice(0, 19)}…` : d;
}

export interface RoutineListItem {
	id: string;
	policy: Manifest["policy"];
	description?: string;
}

export function formatRoutineList(items: RoutineListItem[]): string {
	if (items.length === 0) return "No routines configured. Add some under `routines` in chit.config.json.";
	const w = Math.max(...items.map((i) => i.id.length));
	const lines = items.map(
		(i) => `  ${pad(i.id, w)}  ${pad(i.policy, 9)}  ${i.description ?? ""}`.trimEnd(),
	);
	return [`routines (${items.length}):`, ...lines].join("\n");
}

export function formatInspect(routine: ResolvedRoutine): string {
	const m = routine.manifest;
	const out: string[] = [];
	out.push(`${routine.id}  (${m.policy})`);
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

	const pnames = Object.keys(m.participants);
	const pw = Math.max(...pnames.map((n) => n.length));
	out.push("participants:");
	for (const [id, p] of Object.entries(m.participants)) {
		out.push(`  ${pad(id, pw)}  ${pad(p.agent, 8)}  filesystem: ${p.filesystem}`);
	}
	out.push("");

	// Both policies are ordered steps; checks are just a step kind.
	out.push("steps:");
	m.steps.forEach((s, i) => {
		const what =
			s.kind === "call"
				? `call ${s.call}`
				: s.kind === "format"
					? "format"
					: `check: ${s.checks.map((c) => [c.command, ...c.args].join(" ")).join(", ")}`;
		out.push(`  ${i + 1}. ${pad(s.id, 10)} ${what}`);
	});
	if (m.policy === "one-shot") {
		out.push(`output: ${m.output}`);
	} else {
		const mi = routine.defaults?.maxIterations ?? m.maxIterations;
		out.push(`loop:   repeat the steps until all check steps pass${mi !== undefined ? `, max ${mi} iterations` : ""}`);
		out.push("");
		out.push("note: converge has a working step-based executor (proven under test); live `chit run`");
		out.push("      is gated until a write-safety slice lands (a read-write step edits files unsandboxed).");
	}
	out.push("");
	out.push(`manifest: ${routine.manifestPath}`);
	out.push(`digest:   ${shortDigest(routine.digest)}`);
	return out.join("\n");
}

export function formatTrace(r: RunReceipt | ConvergeReceipt): string {
	const out: string[] = [];
	out.push(`${r.runId}  ${r.routineId}  ${r.status}`);
	if (r.scope) out.push(`scope:    ${r.scope}`);
	out.push(`elapsed:  ${r.elapsedMs}ms`);
	out.push(`digest:   ${shortDigest(r.digest)}`);
	const inputKeys = Object.keys(r.inputs);
	out.push(`inputs:   ${inputKeys.length > 0 ? inputKeys.join(", ") : "none"}`);

	if (r.policy === "converge") {
		out.push(`iterations: ${r.iterations.length} (max ${r.maxIterations})`);
		for (const it of r.iterations) {
			out.push(`  iteration ${it.n}  ${it.allChecksPassed ? "checks passed" : "checks failed"}`);
			const w = Math.max(1, ...it.steps.map((s) => s.id.length));
			for (const s of it.steps) {
				const who = s.kind === "call" ? `call ${s.participant}` : s.kind;
				let line = `    ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 6)}  ${s.elapsedMs}ms`;
				if (s.checks) line += `  [${s.checks.map((c) => `${c.command}:${c.ok ? "ok" : "fail"}`).join(", ")}]`;
				out.push(line);
				if (s.error) out.push(`      error: ${s.error}`);
			}
		}
		if (r.status === "failed") out.push(`error:    ${r.error ?? "(unknown)"}`);
		return out.join("\n");
	}

	out.push("steps:");
	const w = Math.max(1, ...r.steps.map((s) => s.id.length));
	for (const s of r.steps) {
		const who = s.kind === "call" ? `call ${s.participant}` : "format";
		out.push(`  ${pad(s.id, w)}  ${pad(who, 16)}  ${pad(s.status, 6)}  ${s.elapsedMs}ms`);
	}
	if (r.status === "failed") {
		out.push(`error:    ${r.error ?? "(unknown)"}`);
	} else if (r.output !== undefined) {
		// The receipt keeps the final output, but trace summarizes it -- the body was
		// printed at run time; this view is the audit record, not a transcript dump.
		out.push(`output:   ${r.output.length} chars (printed at run time; not shown here)`);
	}
	return out.join("\n");
}
