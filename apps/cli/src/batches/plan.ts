// Validate and normalize an explicit task graph into BatchTasks. v1 takes a
// reviewed task list (NO GitHub coupling, no claim heuristic): the caller hands
// chit a graph, chit runs it. Validation is conservative and fails loudly so a
// malformed batch never launches background jobs.
//
// Rules enforced here:
//   - task ids are safe slugs, unique.
//   - every dependency references a task in the same batch; the graph is acyclic.
//   - claimedPaths is required and non-empty UNLESS the task sets allowPathOverlap
//     (an explicit opt-in to running without a declared footprint).

import type { RequiredCheck } from "@chit-run/core";
import type { BatchTask } from "./types.ts";

export class PlanError extends Error {}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Normalize a claimed path to a canonical repo-relative form so the overlap check
// (overlap.ts, raw string comparison) is not fooled by `./`, `//`, or trailing
// slashes: `src/**` and `./src//` must compare equal. Rejects absolute paths and
// `..` traversal (a claim must name a path inside the repo). Preserves a trailing
// `/**` or `/` (the subtree markers overlap.ts keys on).
export function normalizeClaim(claim: string, taskId: string): string {
	const raw = claim.trim();
	if (raw === "") throw new PlanError(`task ${JSON.stringify(taskId)}: a claimedPath is empty`);
	if (raw.startsWith("/")) {
		throw new PlanError(
			`task ${JSON.stringify(taskId)}: claimedPath must be repo-relative, got ${JSON.stringify(claim)}`,
		);
	}
	const dirGlob = raw.endsWith("/**");
	const dirSlash = !dirGlob && raw.endsWith("/");
	const body = dirGlob ? raw.slice(0, -3) : dirSlash ? raw.slice(0, -1) : raw;
	const segments: string[] = [];
	for (const seg of body.split("/")) {
		if (seg === "" || seg === ".") continue; // collapse `//`, drop `./`
		if (seg === "..") {
			throw new PlanError(
				`task ${JSON.stringify(taskId)}: claimedPath may not contain "..": ${JSON.stringify(claim)}`,
			);
		}
		segments.push(seg);
	}
	if (segments.length === 0) {
		throw new PlanError(
			`task ${JSON.stringify(taskId)}: claimedPath is empty after normalization: ${JSON.stringify(claim)}`,
		);
	}
	const base = segments.join("/");
	return dirGlob ? `${base}/**` : dirSlash ? `${base}/` : base;
}

// The caller-facing shape of one task in chit_batch_start.
export interface TaskInput {
	id: string;
	title: string;
	body: string;
	dependencies?: string[];
	claimedPaths?: string[];
	allowPathOverlap?: boolean;
	manifestPath?: string;
	// Per-task chit-executed verification (overrides batch + manifest for this task).
	requiredChecks?: RequiredCheck[];
}

// Validate the inputs and produce pending BatchTasks. Throws PlanError on the
// first structural problem (bad id, unknown/cyclic dependency, missing claims).
export function planTasks(inputs: TaskInput[]): BatchTask[] {
	if (inputs.length === 0) throw new PlanError("a batch needs at least one task");

	const ids = new Set<string>();
	for (const t of inputs) {
		if (!SAFE_TASK_ID.test(t.id)) {
			throw new PlanError(
				`invalid task id ${JSON.stringify(t.id)} (use [A-Za-z0-9][A-Za-z0-9_-]*)`,
			);
		}
		if (ids.has(t.id)) throw new PlanError(`duplicate task id ${JSON.stringify(t.id)}`);
		ids.add(t.id);
		if (!t.title?.trim()) throw new PlanError(`task ${JSON.stringify(t.id)}: title is required`);
		if (!t.body?.trim()) throw new PlanError(`task ${JSON.stringify(t.id)}: body is required`);
	}

	for (const t of inputs) {
		for (const dep of t.dependencies ?? []) {
			if (!ids.has(dep)) {
				throw new PlanError(
					`task ${JSON.stringify(t.id)} depends on unknown task ${JSON.stringify(dep)}`,
				);
			}
			if (dep === t.id) throw new PlanError(`task ${JSON.stringify(t.id)} depends on itself`);
		}
		const claims = t.claimedPaths ?? [];
		if (claims.length === 0 && !t.allowPathOverlap) {
			throw new PlanError(
				`task ${JSON.stringify(t.id)}: claimedPaths is required (declare the paths it will touch), ` +
					"or set allowPathOverlap to run it without a declared footprint (it will run alone)",
			);
		}
	}

	assertAcyclic(inputs);

	return inputs.map((t) => {
		const task: BatchTask = {
			id: t.id,
			title: t.title,
			body: t.body,
			status: "pending",
			dependencies: [...(t.dependencies ?? [])],
			// Normalized so overlap.ts compares canonical forms (rejects absolute/.. here).
			claimedPaths: (t.claimedPaths ?? []).map((c) => normalizeClaim(c, t.id)),
		};
		if (t.allowPathOverlap) task.allowPathOverlap = true;
		if (t.manifestPath !== undefined) task.manifestPath = t.manifestPath;
		if (t.requiredChecks !== undefined) task.requiredChecks = t.requiredChecks;
		return task;
	});
}

// Depth-first cycle detection over the dependency edges. Names the cycle.
function assertAcyclic(inputs: TaskInput[]): void {
	const deps = new Map(inputs.map((t) => [t.id, t.dependencies ?? []]));
	const state = new Map<string, "visiting" | "done">();

	const visit = (id: string, stack: string[]): void => {
		const s = state.get(id);
		if (s === "done") return;
		if (s === "visiting") {
			const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
			throw new PlanError(`dependency cycle: ${cycle}`);
		}
		state.set(id, "visiting");
		for (const dep of deps.get(id) ?? []) visit(dep, [...stack, id]);
		state.set(id, "done");
	};

	for (const t of inputs) visit(t.id, []);
}

// Resolve the converge manifest for a task: task override -> batch default ->
// undefined (the caller then uses the bundled default converge manifest).
export function resolveManifestPath(
	task: BatchTask,
	batchDefault: string | undefined,
): string | undefined {
	return task.manifestPath ?? batchDefault;
}
