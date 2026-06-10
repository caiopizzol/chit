// Browser-safe parser/validator for a sequential plan file
// (see docs/sequential-plan-runner-design.md). It validates structure and the
// dependency graph (ids unique, dependsOn references exist, acyclic) the way
// planTasks does for a batch, and normalizes defaults. No fs, no node-only imports:
// node-side resolution (manifest paths, integration branch) layers on top.

import type { RequiredCheck } from "../manifest/types.ts";
import type { NormalizedPlan, PlanApplyPolicy, PlanCleanupPolicy, PlanStep } from "./types.ts";

export class PlanError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "PlanError";
	}
}

const ALLOWED_TOP_KEYS = new Set([
	"schema",
	"id",
	"title",
	"baseBranch",
	"steps",
	"apply",
	"cleanup",
]);
const ALLOWED_STEP_KEYS = new Set([
	"id",
	"title",
	"body",
	"dependsOn",
	"commitMessage",
	"requiredChecks",
	"recipe",
	"manifestPath",
	"maxIterations",
	"callTimeoutMs",
]);
// Strict per-check allowlist mirroring the manifest RequiredCheck shape: command +
// args + name + timeout only. No env, cwd, or shell strings -- a required check is a
// process chit spawns, not a shell snippet. Kept identical so the two never drift.
const ALLOWED_REQUIRED_CHECK_KEYS = new Set(["command", "args", "name", "timeoutMs"]);

// The plan id is a kebab-case slug, matching the manifest top-level id convention.
const PLAN_ID_RE = /^[a-z][a-z0-9-]*$/;
// A step's recipe reference must be a config recipe id, which the config parser pins to
// the same kebab-case convention. Rejecting non-slugs here keeps a path (or any other
// synthesized value) from ever reading as a recipe reference.
const RECIPE_ID_RE = /^[a-z][a-z0-9-]*$/;
// Step ids match the batch task-id convention (they are the same concept: a unit of
// work in a declared graph). Slightly looser than the plan id, allowing leading
// digits and underscores, exactly as planTasks accepts.
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Reserved JS object-prototype keys. Step ids become keys in the dependency map (and
// node-side records), so allowing these would let a plan pollute prototypes.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

const ALLOWED_APPLY: ReadonlySet<string> = new Set<PlanApplyPolicy>(["gated"]);
const ALLOWED_CLEANUP: ReadonlySet<string> = new Set<PlanCleanupPolicy>(["after_apply", "manual"]);

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reqNonEmptyString(v: unknown, path: string): string {
	if (typeof v !== "string" || !v) throw new PlanError(path, "must be a non-empty string");
	return v;
}

function reqPositiveInt(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
		throw new PlanError(path, "must be an integer >= 1");
	return v;
}

// A step's commit message is the commit SUBJECT the gated apply uses on the integration
// branch: one non-blank line. Multiline bodies are rejected (the subject is the whole
// reviewed surface; a body would hide unreviewed text below the fold of every listing).
function reqSingleLineString(v: unknown, path: string): string {
	if (typeof v !== "string" || v.trim() === "")
		throw new PlanError(path, "must be a non-blank string");
	if (/[\r\n]/.test(v)) throw new PlanError(path, "must be a single line (no newlines)");
	return v.trim();
}

// Parse a step's requiredChecks: an array of structured commands chit runs itself.
// Identical validation to the manifest parser so a check authored for a manifest and
// one authored for a plan accept exactly the same fields.
function parseRequiredChecks(raw: unknown, path: string): RequiredCheck[] {
	if (!Array.isArray(raw)) throw new PlanError(path, "must be an array");
	return raw.map((entry, i) => {
		const at = `${path}[${i}]`;
		if (!isObject(entry)) throw new PlanError(at, "must be an object");
		for (const k of Object.keys(entry)) {
			if (!ALLOWED_REQUIRED_CHECK_KEYS.has(k))
				throw new PlanError(`${at}.${k}`, "unknown field (only command, args, name, timeoutMs)");
		}
		const check: RequiredCheck = {
			command: reqNonEmptyString(entry.command, `${at}.command`),
			args: [],
		};
		if (entry.args !== undefined) {
			if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string"))
				throw new PlanError(`${at}.args`, "must be an array of strings");
			check.args = entry.args as string[];
		}
		if (entry.name !== undefined) check.name = reqNonEmptyString(entry.name, `${at}.name`);
		if (entry.timeoutMs !== undefined)
			check.timeoutMs = reqPositiveInt(entry.timeoutMs, `${at}.timeoutMs`);
		return check;
	});
}

function parseStep(raw: unknown, index: number, ids: Set<string>): PlanStep {
	const at = `steps[${index}]`;
	if (!isObject(raw)) throw new PlanError(at, "must be an object");
	for (const k of Object.keys(raw)) {
		if (!ALLOWED_STEP_KEYS.has(k)) throw new PlanError(`${at}.${k}`, "unknown field");
	}

	const id = reqNonEmptyString(raw.id, `${at}.id`);
	if (!STEP_ID_RE.test(id))
		throw new PlanError(`${at}.id`, "step id must be a safe slug ([A-Za-z0-9][A-Za-z0-9_-]*)");
	if (RESERVED_IDS.has(id)) throw new PlanError(`${at}.id`, "step id must not be a reserved name");
	if (ids.has(id)) throw new PlanError(`${at}.id`, `duplicate step id "${id}"`);
	ids.add(id);

	const step: PlanStep = {
		id,
		title: reqNonEmptyString(raw.title, `steps.${id}.title`),
		body: reqNonEmptyString(raw.body, `steps.${id}.body`),
		dependsOn: parseDependsOn(raw.dependsOn, id),
	};

	if (raw.commitMessage !== undefined)
		step.commitMessage = reqSingleLineString(raw.commitMessage, `steps.${id}.commitMessage`);
	if (raw.requiredChecks !== undefined)
		step.requiredChecks = parseRequiredChecks(raw.requiredChecks, `steps.${id}.requiredChecks`);
	// recipe and manifestPath are mutually exclusive: a recipe RESOLVES to a vetted
	// manifest, so a step naming both would carry two competing execution references
	// and the launch could not know which one was reviewed.
	if (raw.recipe !== undefined && raw.manifestPath !== undefined)
		throw new PlanError(
			`steps.${id}.recipe`,
			"recipe and manifestPath are mutually exclusive (the recipe supplies the manifest)",
		);
	if (raw.recipe !== undefined) {
		const recipe = reqNonEmptyString(raw.recipe, `steps.${id}.recipe`);
		if (!RECIPE_ID_RE.test(recipe))
			throw new PlanError(
				`steps.${id}.recipe`,
				"must be a config recipe id (kebab-case: lowercase letters, digits, hyphens; starts with a letter)",
			);
		step.recipe = recipe;
	}
	if (raw.manifestPath !== undefined)
		step.manifestPath = reqNonEmptyString(raw.manifestPath, `steps.${id}.manifestPath`);
	if (raw.maxIterations !== undefined)
		step.maxIterations = reqPositiveInt(raw.maxIterations, `steps.${id}.maxIterations`);
	if (raw.callTimeoutMs !== undefined)
		step.callTimeoutMs = reqPositiveInt(raw.callTimeoutMs, `steps.${id}.callTimeoutMs`);

	return step;
}

// dependsOn defaults to [] (depends on the plan base only). Each entry must be a
// step id string; reference existence and acyclicity are checked once all ids are
// known (assertGraph).
function parseDependsOn(raw: unknown, stepId: string): string[] {
	if (raw === undefined) return [];
	const path = `steps.${stepId}.dependsOn`;
	if (!Array.isArray(raw)) throw new PlanError(path, "must be an array of step ids");
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

// Validate the dependency edges: every dependsOn references a declared step, no step
// depends on itself, and the graph is acyclic. Depth-first cycle detection names the
// cycle, mirroring planTasks.
function assertGraph(steps: PlanStep[]): void {
	const ids = new Set(steps.map((s) => s.id));
	for (const step of steps) {
		for (const dep of step.dependsOn) {
			if (dep === step.id)
				throw new PlanError(`steps.${step.id}.dependsOn`, `step "${step.id}" depends on itself`);
			if (!ids.has(dep))
				throw new PlanError(`steps.${step.id}.dependsOn`, `references unknown step "${dep}"`);
		}
	}

	const deps = new Map(steps.map((s) => [s.id, s.dependsOn]));
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, stack: string[]): void => {
		const s = state.get(id);
		if (s === "done") return;
		if (s === "visiting") {
			const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
			throw new PlanError("steps", `dependency cycle: ${cycle}`);
		}
		state.set(id, "visiting");
		for (const dep of deps.get(id) ?? []) visit(dep, [...stack, id]);
		state.set(id, "done");
	};
	for (const step of steps) visit(step.id, []);
}

export function parsePlan(raw: unknown): NormalizedPlan {
	if (!isObject(raw)) throw new PlanError("$", "plan must be a JSON object");

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_TOP_KEYS.has(k)) throw new PlanError(k, "unknown top-level field");
	}

	if (raw.schema !== 1) throw new PlanError("schema", "must be 1");

	const title = reqNonEmptyString(raw.title, "title");

	if (!Array.isArray(raw.steps)) throw new PlanError("steps", "must be an array");
	if (raw.steps.length === 0) throw new PlanError("steps", "must define at least one step");

	const ids = new Set<string>();
	const steps = raw.steps.map((s, i) => parseStep(s, i, ids));
	assertGraph(steps);

	const plan: NormalizedPlan = {
		schema: 1,
		title,
		steps,
		cleanup: parseCleanup(raw.cleanup),
	};

	if (raw.id !== undefined) {
		const id = reqNonEmptyString(raw.id, "id");
		if (!PLAN_ID_RE.test(id))
			throw new PlanError(
				"id",
				"must be a kebab-case slug (lowercase letters, digits, hyphens; starts with a letter)",
			);
		if (RESERVED_IDS.has(id)) throw new PlanError("id", "must not be a reserved name");
		plan.id = id;
	}
	if (raw.baseBranch !== undefined)
		plan.baseBranch = reqNonEmptyString(raw.baseBranch, "baseBranch");
	if (raw.apply !== undefined) plan.apply = parseApply(raw.apply);

	return plan;
}

// v1 fixes apply to "gated": auto-apply is rejected because it would flow a diff with
// no human in the loop. The field is preserved only when the author provides it.
function parseApply(raw: unknown): PlanApplyPolicy {
	if (typeof raw !== "string" || !ALLOWED_APPLY.has(raw))
		throw new PlanError("apply", `must be "gated" (the only legal value in v1)`);
	return raw as PlanApplyPolicy;
}

// cleanup defaults to "after_apply" when absent.
function parseCleanup(raw: unknown): PlanCleanupPolicy {
	if (raw === undefined) return "after_apply";
	if (typeof raw !== "string" || !ALLOWED_CLEANUP.has(raw))
		throw new PlanError("cleanup", `must be one of: ${[...ALLOWED_CLEANUP].join(", ")}`);
	return raw as PlanCleanupPolicy;
}
