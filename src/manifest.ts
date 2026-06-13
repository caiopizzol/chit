// A routine is ONE shape: inputs + participants + ordered steps + optional repeat
// + optional output. There is no `policy` field -- behavior is DERIVED from the
// structure, so the user describes the work, not its execution category:
//
//   steps are `routine` steps                 -> composition (run them in order)
//   `repeat` present                          -> loop until checks pass
//   any read-write participant OR check step  -> runs in a git-worktree sandbox
//   pure read-only call/format, no checks     -> runs read-only in the cwd
//
// Parsing validates STRUCTURE (and the no-mixing / repeat / output rules, which
// need no config). Cross-routine rules (sub-routines exist, composition shape)
// are config-aware and live in resolve.

export type Filesystem = "read-only" | "read-write" | "none";

const FILESYSTEMS = new Set<Filesystem>(["read-only", "read-write", "none"]);

export interface InputSpec {
	type: "string";
	required: boolean;
	description?: string;
}

export interface Participant {
	id: string;
	agent: string;
	instructions: string;
	filesystem: Filesystem;
}

export interface Check {
	command: string;
	args: string[];
}

export interface CallStep {
	id: string;
	kind: "call";
	call: string;
	prompt: string;
}
export interface FormatStep {
	id: string;
	kind: "format";
	format: string;
}
export interface CheckStep {
	id: string;
	kind: "check";
	checks: Check[];
}
export interface RoutineStep {
	id: string;
	kind: "routine";
	routine: string;
	inputs: Record<string, string>;
}
export type Step = CallStep | FormatStep | CheckStep | RoutineStep;

export interface Repeat {
	until: "checks-pass";
	maxIterations?: number;
}

export interface Manifest {
	id: string;
	description?: string;
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	steps: Step[];
	repeat?: Repeat;
	output?: string;
}

// --- derived behavior (the user never writes these) ---

export function isComposition(m: Manifest): boolean {
	return m.steps.length > 0 && m.steps.every((s) => s.kind === "routine");
}

export function hasChecks(m: Manifest): boolean {
	return m.steps.some((s) => s.kind === "check");
}

export function hasWriteParticipant(m: Manifest): boolean {
	return Object.values(m.participants).some((p) => p.filesystem === "read-write");
}

// A routine touches the filesystem if it can run commands (checks) or edit files
// (a read-write participant). Those get the worktree boundary; pure read-only
// call/format routines run in the cwd.
export function isSandboxed(m: Manifest): boolean {
	return hasChecks(m) || hasWriteParticipant(m);
}

export type RoutineKind = "composition" | "execution";
export function routineKind(m: Manifest): RoutineKind {
	return isComposition(m) ? "composition" : "execution";
}

// A short human label for the routine list / inspect header, derived from shape.
export function kindLabel(m: Manifest): string {
	if (isComposition(m)) return "composition";
	if (m.repeat !== undefined) return "loop";
	if (isSandboxed(m)) return "sandboxed";
	return "text";
}

export class ManifestError extends Error {
	constructor(
		readonly source: string,
		readonly detail: string,
	) {
		super(`${source}: ${detail}`);
		this.name = "ManifestError";
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireKeys(raw: Record<string, unknown>, allowed: Set<string>, source: string): void {
	for (const k of Object.keys(raw)) {
		if (!allowed.has(k)) throw new ManifestError(source, `unknown field "${k}"`);
	}
}

function parseInputs(raw: unknown, source: string): Record<string, InputSpec> {
	if (raw === undefined) return {};
	if (!isObject(raw)) throw new ManifestError(source, "`inputs` must be an object");
	const out: Record<string, InputSpec> = {};
	for (const [name, spec] of Object.entries(raw)) {
		const where = `${source}.inputs.${name}`;
		if (!isObject(spec)) throw new ManifestError(where, "must be an object");
		requireKeys(spec, new Set(["type", "required", "description"]), where);
		if (spec.type !== "string") throw new ManifestError(where, '`type` must be "string"');
		if (spec.required !== undefined && typeof spec.required !== "boolean") {
			throw new ManifestError(where, "`required` must be a boolean");
		}
		if (spec.description !== undefined && typeof spec.description !== "string") {
			throw new ManifestError(where, "`description` must be a string");
		}
		out[name] = {
			type: "string",
			required: spec.required ?? true,
			...(typeof spec.description === "string" && { description: spec.description }),
		};
	}
	return out;
}

function parseParticipants(raw: unknown, source: string): Record<string, Participant> {
	if (raw === undefined) return {};
	if (!isObject(raw)) throw new ManifestError(source, "`participants` must be an object");
	const out: Record<string, Participant> = {};
	for (const [id, spec] of Object.entries(raw)) {
		const where = `${source}.participants.${id}`;
		if (!isObject(spec)) throw new ManifestError(where, "must be an object");
		requireKeys(spec, new Set(["agent", "instructions", "filesystem"]), where);
		if (typeof spec.agent !== "string" || !spec.agent) {
			throw new ManifestError(where, "`agent` must be a non-empty string");
		}
		if (typeof spec.instructions !== "string" || !spec.instructions) {
			throw new ManifestError(where, "`instructions` must be a non-empty string");
		}
		if (typeof spec.filesystem !== "string" || !FILESYSTEMS.has(spec.filesystem as Filesystem)) {
			throw new ManifestError(where, `\`filesystem\` must be one of: ${[...FILESYSTEMS].join(", ")}`);
		}
		out[id] = { id, agent: spec.agent, instructions: spec.instructions, filesystem: spec.filesystem as Filesystem };
	}
	return out;
}

function parseCheckArray(raw: unknown, where: string): Check[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new ManifestError(where, "`check` must be a non-empty array of commands");
	}
	return raw.map((c, i) => {
		const at = `${where}[${i}]`;
		if (!isObject(c)) throw new ManifestError(at, "must be an object");
		requireKeys(c, new Set(["command", "args"]), at);
		if (typeof c.command !== "string" || !c.command) throw new ManifestError(at, "`command` must be a non-empty string");
		const args = c.args ?? [];
		if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
			throw new ManifestError(at, "`args` must be an array of strings");
		}
		return { command: c.command, args: args as string[] };
	});
}

function parseSteps(raw: unknown, source: string, participants: Record<string, Participant>): Step[] {
	if (!Array.isArray(raw)) throw new ManifestError(source, "`steps` must be an array");
	if (raw.length === 0) throw new ManifestError(source, "`steps` must not be empty");
	const out: Step[] = [];
	const seen = new Set<string>();
	for (const [i, s] of raw.entries()) {
		const where = `${source}.steps[${i}]`;
		if (!isObject(s)) throw new ManifestError(where, "must be an object");
		if (typeof s.id !== "string" || !s.id) throw new ManifestError(where, "`id` must be a non-empty string");
		if (seen.has(s.id)) throw new ManifestError(where, `duplicate step id "${s.id}"`);
		seen.add(s.id);
		const kinds = (["call", "format", "check", "routine"] as const).filter((k) => s[k] !== undefined);
		if (kinds.length !== 1) {
			throw new ManifestError(where, "a step is exactly one of `call`, `format`, `check`, or `routine`");
		}
		const kind = kinds[0];
		if (kind === "call") {
			requireKeys(s, new Set(["id", "call", "prompt"]), where);
			if (typeof s.call !== "string" || !(s.call in participants)) {
				throw new ManifestError(where, `\`call\` must name a participant (got ${JSON.stringify(s.call)})`);
			}
			if (typeof s.prompt !== "string" || !s.prompt) throw new ManifestError(where, "`prompt` must be a non-empty string");
			out.push({ id: s.id, kind: "call", call: s.call, prompt: s.prompt });
		} else if (kind === "format") {
			requireKeys(s, new Set(["id", "format"]), where);
			if (typeof s.format !== "string" || !s.format) throw new ManifestError(where, "`format` must be a non-empty string");
			out.push({ id: s.id, kind: "format", format: s.format });
		} else if (kind === "check") {
			requireKeys(s, new Set(["id", "check"]), where);
			out.push({ id: s.id, kind: "check", checks: parseCheckArray(s.check, `${where}.check`) });
		} else {
			requireKeys(s, new Set(["id", "routine", "inputs"]), where);
			if (typeof s.routine !== "string" || !s.routine) throw new ManifestError(where, "`routine` must be a non-empty routine id");
			const inputs: Record<string, string> = {};
			if (s.inputs !== undefined) {
				if (!isObject(s.inputs)) throw new ManifestError(`${where}.inputs`, "must be an object");
				for (const [k, v] of Object.entries(s.inputs)) {
					if (typeof v !== "string") throw new ManifestError(`${where}.inputs.${k}`, "must be a string template");
					inputs[k] = v;
				}
			}
			out.push({ id: s.id, kind: "routine", routine: s.routine, inputs });
		}
	}
	return out;
}

export function parseManifest(raw: unknown, source: string): Manifest {
	if (!isObject(raw)) throw new ManifestError(source, "manifest must be an object");
	if (typeof raw.id !== "string" || !raw.id) throw new ManifestError(source, "`id` must be a non-empty string");
	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw new ManifestError(source, "`description` must be a string");
	}
	requireKeys(raw, new Set(["id", "description", "inputs", "participants", "steps", "repeat", "output"]), source);

	const inputs = parseInputs(raw.inputs, source);
	const participants = parseParticipants(raw.participants, source);
	const steps = parseSteps(raw.steps, source, participants);

	// Rule 1: no step mixing -- all `routine` (composition) OR none (execution).
	const routineCount = steps.filter((s) => s.kind === "routine").length;
	if (routineCount > 0 && routineCount < steps.length) {
		throw new ManifestError(source, "steps must be either all `routine` steps (a composition) or call/format/check (an execution), not a mix");
	}
	const composition = routineCount > 0;

	// Rule 2: repeat needs >=1 check and an execution routine.
	let repeat: Repeat | undefined;
	if (raw.repeat !== undefined) {
		if (!isObject(raw.repeat)) throw new ManifestError(`${source}.repeat`, "must be an object");
		requireKeys(raw.repeat, new Set(["until", "maxIterations"]), `${source}.repeat`);
		if (raw.repeat.until !== "checks-pass") throw new ManifestError(`${source}.repeat`, '`until` must be "checks-pass"');
		if (raw.repeat.maxIterations !== undefined) {
			const mi = raw.repeat.maxIterations;
			if (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1) {
				throw new ManifestError(`${source}.repeat`, "`maxIterations` must be a positive integer");
			}
		}
		if (composition) throw new ManifestError(source, "`repeat` is not valid on a composition (a composition's sub-routines repeat themselves)");
		if (!steps.some((s) => s.kind === "check")) {
			throw new ManifestError(source, "`repeat` requires at least one `check` step (its convergence signal)");
		}
		repeat = { until: "checks-pass", ...(typeof raw.repeat.maxIterations === "number" && { maxIterations: raw.repeat.maxIterations }) };
	}

	// Rule 3: output names a TEXT-producing step (call/format/routine), never a check.
	let output: string | undefined;
	if (raw.output !== undefined) {
		if (typeof raw.output !== "string") throw new ManifestError(source, "`output` must be a string");
		const target = steps.find((s) => s.id === raw.output);
		if (target === undefined) throw new ManifestError(source, "`output` must name one of the steps");
		if (target.kind === "check") throw new ManifestError(source, "`output` cannot name a `check` step (it produces no text)");
		output = raw.output;
	}

	return {
		id: raw.id,
		...(typeof raw.description === "string" && { description: raw.description }),
		inputs,
		participants,
		steps,
		...(repeat !== undefined && { repeat }),
		...(output !== undefined && { output }),
	};
}
