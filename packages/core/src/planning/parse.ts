// Browser-safe parser/validator for a planner-authored execution draft (see
// types.ts). It validates STRUCTURE and the dependency graph (safe unique ids, both
// dependency kinds reference declared steps, the combined graph is acyclic). It does
// NOT resolve profiles or enforce strategy-specific semantics -- that is the
// compilers' job (compile.ts), so a draft object is a faithful record of what the
// planner authored before any strategy lens is applied. No node imports.

import type { RequiredCheck } from "../manifest/types.ts";
import type { DraftStep, DraftStrategy, PlannerDraft } from "./types.ts";

export class DraftError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "DraftError";
	}
}

const ALLOWED_TOP_KEYS = new Set(["schema", "strategy", "title", "steps"]);
const ALLOWED_STEP_KEYS = new Set([
	"id",
	"title",
	"body",
	"profileId",
	"requiredChecks",
	"maxIterations",
	"callTimeoutMs",
	"codeDependsOn",
	"orderDependsOn",
	"claimedPaths",
	"allowPathOverlap",
]);
// Mirrors the manifest/plan RequiredCheck allowlist exactly so a check authored in a
// draft validates identically to one authored in a manifest or plan.
const ALLOWED_REQUIRED_CHECK_KEYS = new Set(["command", "args", "name", "timeoutMs"]);

const ALLOWED_STRATEGIES: ReadonlySet<string> = new Set<DraftStrategy>(["plan", "batch"]);
// Step ids match the plan/batch task-id convention: a safe slug usable as an object
// key and a branch/worktree name component.
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// profileId is kebab-case, matching the profile id convention in config.
const PROFILE_ID_RE = /^[a-z][a-z0-9-]*$/;
// Reserved JS object-prototype keys: a step id becomes a key in the dependency map.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reqNonEmptyString(v: unknown, path: string): string {
	if (typeof v !== "string" || !v) throw new DraftError(path, "must be a non-empty string");
	return v;
}

function reqPositiveInt(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
		throw new DraftError(path, "must be an integer >= 1");
	return v;
}

function parseRequiredChecks(raw: unknown, path: string): RequiredCheck[] {
	if (!Array.isArray(raw)) throw new DraftError(path, "must be an array");
	return raw.map((entry, i) => {
		const at = `${path}[${i}]`;
		if (!isObject(entry)) throw new DraftError(at, "must be an object");
		for (const k of Object.keys(entry)) {
			if (!ALLOWED_REQUIRED_CHECK_KEYS.has(k))
				throw new DraftError(`${at}.${k}`, "unknown field (only command, args, name, timeoutMs)");
		}
		const check: RequiredCheck = {
			command: reqNonEmptyString(entry.command, `${at}.command`),
			args: [],
		};
		if (entry.args !== undefined) {
			if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string"))
				throw new DraftError(`${at}.args`, "must be an array of strings");
			check.args = entry.args as string[];
		}
		if (entry.name !== undefined) check.name = reqNonEmptyString(entry.name, `${at}.name`);
		if (entry.timeoutMs !== undefined)
			check.timeoutMs = reqPositiveInt(entry.timeoutMs, `${at}.timeoutMs`);
		return check;
	});
}

// Parse one dependency-id list. Each entry must be a non-empty string; duplicates are
// dropped. Reference existence and acyclicity are checked across BOTH kinds once all
// ids are known (assertGraph).
function parseDepList(raw: unknown, path: string): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new DraftError(path, "must be an array of step ids");
	const out: string[] = [];
	const seen = new Set<string>();
	raw.forEach((dep, i) => {
		const id = reqNonEmptyString(dep, `${path}[${i}]`);
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	});
	return out;
}

function parseStep(raw: unknown, index: number, ids: Set<string>): DraftStep {
	const at = `steps[${index}]`;
	if (!isObject(raw)) throw new DraftError(at, "must be an object");
	for (const k of Object.keys(raw)) {
		if (!ALLOWED_STEP_KEYS.has(k)) throw new DraftError(`${at}.${k}`, "unknown field");
	}

	const id = reqNonEmptyString(raw.id, `${at}.id`);
	if (!STEP_ID_RE.test(id))
		throw new DraftError(`${at}.id`, "step id must be a safe slug ([A-Za-z0-9][A-Za-z0-9_-]*)");
	if (RESERVED_IDS.has(id)) throw new DraftError(`${at}.id`, "step id must not be a reserved name");
	if (ids.has(id)) throw new DraftError(`${at}.id`, `duplicate step id "${id}"`);
	ids.add(id);

	const step: DraftStep = {
		id,
		title: reqNonEmptyString(raw.title, `steps.${id}.title`),
		body: reqNonEmptyString(raw.body, `steps.${id}.body`),
		codeDependsOn: parseDepList(raw.codeDependsOn, `steps.${id}.codeDependsOn`),
		orderDependsOn: parseDepList(raw.orderDependsOn, `steps.${id}.orderDependsOn`),
	};

	if (raw.profileId !== undefined) {
		const pid = reqNonEmptyString(raw.profileId, `steps.${id}.profileId`);
		if (!PROFILE_ID_RE.test(pid))
			throw new DraftError(
				`steps.${id}.profileId`,
				"profile id must be kebab-case (lowercase letters, digits, hyphens; starts with a letter)",
			);
		step.profileId = pid;
	}
	if (raw.requiredChecks !== undefined)
		step.requiredChecks = parseRequiredChecks(raw.requiredChecks, `steps.${id}.requiredChecks`);
	if (raw.maxIterations !== undefined)
		step.maxIterations = reqPositiveInt(raw.maxIterations, `steps.${id}.maxIterations`);
	if (raw.callTimeoutMs !== undefined)
		step.callTimeoutMs = reqPositiveInt(raw.callTimeoutMs, `steps.${id}.callTimeoutMs`);
	if (raw.claimedPaths !== undefined) step.claimedPaths = parseClaimedPaths(raw.claimedPaths, id);
	if (raw.allowPathOverlap !== undefined) {
		if (typeof raw.allowPathOverlap !== "boolean")
			throw new DraftError(`steps.${id}.allowPathOverlap`, "must be a boolean");
		step.allowPathOverlap = raw.allowPathOverlap;
	}

	return step;
}

// claimedPaths is structurally an array of non-empty strings. The repo-relative /
// no-traversal normalization and the required-unless-overlap rule belong to the batch
// boundary (the batch compiler + planTasks), not to this structural parse.
function parseClaimedPaths(raw: unknown, stepId: string): string[] {
	const path = `steps.${stepId}.claimedPaths`;
	if (!Array.isArray(raw)) throw new DraftError(path, "must be an array of strings");
	return raw.map((p, i) => reqNonEmptyString(p, `${path}[${i}]`));
}

// Validate dependency edges across BOTH kinds at once: a step never depends on itself,
// every referenced id exists, and the union graph is acyclic. The same id may not
// appear in both codeDependsOn and orderDependsOn for one step -- that would assert two
// contradictory intents about the same edge.
function assertGraph(steps: DraftStep[]): void {
	const ids = new Set(steps.map((s) => s.id));
	const edges = new Map<string, string[]>();

	for (const step of steps) {
		const code = step.codeDependsOn ?? [];
		const order = step.orderDependsOn ?? [];
		const codeSet = new Set(code);
		for (const dep of [...code, ...order]) {
			if (dep === step.id)
				throw new DraftError(`steps.${step.id}`, `step "${step.id}" depends on itself`);
			if (!ids.has(dep))
				throw new DraftError(`steps.${step.id}`, `depends on unknown step "${dep}"`);
		}
		for (const dep of order) {
			if (codeSet.has(dep))
				throw new DraftError(
					`steps.${step.id}`,
					`step "${dep}" is listed in both codeDependsOn and orderDependsOn; pick one`,
				);
		}
		edges.set(step.id, [...new Set([...code, ...order])]);
	}

	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, stack: string[]): void => {
		const s = state.get(id);
		if (s === "done") return;
		if (s === "visiting") {
			const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
			throw new DraftError("steps", `dependency cycle: ${cycle}`);
		}
		state.set(id, "visiting");
		for (const dep of edges.get(id) ?? []) visit(dep, [...stack, id]);
		state.set(id, "done");
	};
	for (const step of steps) visit(step.id, []);
}

export function parseDraft(raw: unknown): PlannerDraft {
	if (!isObject(raw)) throw new DraftError("$", "draft must be a JSON object");

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_TOP_KEYS.has(k)) throw new DraftError(k, "unknown top-level field");
	}

	if (raw.schema !== 1) throw new DraftError("schema", "must be 1");

	if (typeof raw.strategy !== "string" || !ALLOWED_STRATEGIES.has(raw.strategy))
		throw new DraftError("strategy", `must be one of: ${[...ALLOWED_STRATEGIES].join(", ")}`);

	const title = reqNonEmptyString(raw.title, "title");

	if (!Array.isArray(raw.steps)) throw new DraftError("steps", "must be an array");
	if (raw.steps.length === 0) throw new DraftError("steps", "must define at least one step");

	const ids = new Set<string>();
	const steps = raw.steps.map((s, i) => parseStep(s, i, ids));
	assertGraph(steps);

	return { schema: 1, strategy: raw.strategy as DraftStrategy, title, steps };
}
