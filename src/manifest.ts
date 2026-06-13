// A manifest is the source of truth for a routine: its inputs, participants,
// ordered steps, policy, prompts, and checks. The config layer only NAMES a
// routine and points at one of these; it never redeclares any of this.
//
// Both policies are just ORDERED STEPS. The difference is termination:
//   one-shot  -- run the steps once; `output` names the step to return.
//   converge  -- run the steps repeatedly until every check step passes (or
//                maxIterations). There is no fixed implementer/reviewer slot:
//                "build"/"critique" are step ids and "builder"/"critic" are
//                participant names, nothing more. Roles are examples, not runtime.

export type Filesystem = "read-only" | "read-write" | "none";
export type Policy = "one-shot" | "converge" | "flow";

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

// A check command: argv only (command + args), never a shell string, so there is
// nothing to quote-escape or inject.
export interface Check {
	command: string;
	args: string[];
}

// One ordered step. `call` invokes a participant with a rendered prompt; `format`
// assembles text without a model call; `check` runs commands and records pass/fail
// (the convergence signal). A step is exactly one kind.
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
export type Step = CallStep | FormatStep | CheckStep;
// One-shot routines cannot contain check steps (a single pass has nothing to
// converge on); the parser enforces it, and this narrower type lets the one-shot
// executor see only the two kinds it handles.
export type OneShotStep = CallStep | FormatStep;

export interface OneShotManifest {
	id: string;
	description?: string;
	policy: "one-shot";
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	steps: OneShotStep[];
	output: string;
}

export interface ConvergeManifest {
	id: string;
	description?: string;
	policy: "converge";
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	steps: Step[];
	maxIterations?: number;
}

// A flow composes OTHER routines: each step invokes a configured routine, mapping
// the flow's inputs and earlier steps' outputs into that routine's inputs. A flow
// has no participants of its own. The referenced routine ids, the no-cycles rule,
// and the "at most one converge step, and it must be last" rule are config-aware,
// so they are checked at RESOLVE time, not in this pure parse.
export interface FlowStep {
	id: string;
	routine: string;
	inputs: Record<string, string>;
}

export interface FlowManifest {
	id: string;
	description?: string;
	policy: "flow";
	inputs: Record<string, InputSpec>;
	steps: FlowStep[];
}

export type Manifest = OneShotManifest | ConvergeManifest | FlowManifest;

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
		out[id] = {
			id,
			agent: spec.agent,
			instructions: spec.instructions,
			filesystem: spec.filesystem as Filesystem,
		};
	}
	if (Object.keys(out).length === 0) {
		throw new ManifestError(source, "a manifest needs at least one participant");
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
		if (typeof c.command !== "string" || !c.command) {
			throw new ManifestError(at, "`command` must be a non-empty string");
		}
		const args = c.args ?? [];
		if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
			throw new ManifestError(at, "`args` must be an array of strings");
		}
		return { command: c.command, args: args as string[] };
	});
}

// Parse the ordered steps. `allowCheck` is false for one-shot (a single pass has
// nothing to converge on), true for converge.
function parseSteps(
	raw: unknown,
	source: string,
	participants: Record<string, Participant>,
	allowCheck: boolean,
): Step[] {
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
		const kinds = (["call", "format", "check"] as const).filter((k) => s[k] !== undefined);
		if (kinds.length !== 1) {
			throw new ManifestError(where, "a step is exactly one of `call`, `format`, or `check`");
		}
		const kind = kinds[0];
		if (kind === "call") {
			requireKeys(s, new Set(["id", "call", "prompt"]), where);
			if (typeof s.call !== "string" || !(s.call in participants)) {
				throw new ManifestError(where, `\`call\` must name a participant (got ${JSON.stringify(s.call)})`);
			}
			if (typeof s.prompt !== "string" || !s.prompt) {
				throw new ManifestError(where, "`prompt` must be a non-empty string");
			}
			out.push({ id: s.id, kind: "call", call: s.call, prompt: s.prompt });
		} else if (kind === "format") {
			requireKeys(s, new Set(["id", "format"]), where);
			if (typeof s.format !== "string" || !s.format) {
				throw new ManifestError(where, "`format` must be a non-empty string");
			}
			out.push({ id: s.id, kind: "format", format: s.format });
		} else {
			if (!allowCheck) {
				throw new ManifestError(where, "`check` steps are only valid in a converge routine");
			}
			requireKeys(s, new Set(["id", "check"]), where);
			out.push({ id: s.id, kind: "check", checks: parseCheckArray(s.check, `${where}.check`) });
		}
	}
	return out;
}

function parseFlowSteps(raw: unknown, source: string): FlowStep[] {
	if (!Array.isArray(raw)) throw new ManifestError(source, "`steps` must be an array");
	if (raw.length === 0) throw new ManifestError(source, "`steps` must not be empty");
	const out: FlowStep[] = [];
	const seen = new Set<string>();
	for (const [i, s] of raw.entries()) {
		const where = `${source}.steps[${i}]`;
		if (!isObject(s)) throw new ManifestError(where, "must be an object");
		if (typeof s.id !== "string" || !s.id) throw new ManifestError(where, "`id` must be a non-empty string");
		if (seen.has(s.id)) throw new ManifestError(where, `duplicate step id "${s.id}"`);
		seen.add(s.id);
		requireKeys(s, new Set(["id", "routine", "inputs"]), where);
		if (typeof s.routine !== "string" || !s.routine) {
			throw new ManifestError(where, "`routine` must be a non-empty routine id");
		}
		const inputs: Record<string, string> = {};
		if (s.inputs !== undefined) {
			if (!isObject(s.inputs)) throw new ManifestError(`${where}.inputs`, "must be an object");
			for (const [k, v] of Object.entries(s.inputs)) {
				if (typeof v !== "string") throw new ManifestError(`${where}.inputs.${k}`, "must be a string template");
				inputs[k] = v;
			}
		}
		out.push({ id: s.id, routine: s.routine, inputs });
	}
	return out;
}

export function parseManifest(raw: unknown, source: string): Manifest {
	if (!isObject(raw)) throw new ManifestError(source, "manifest must be an object");
	if (typeof raw.id !== "string" || !raw.id) {
		throw new ManifestError(source, "`id` must be a non-empty string");
	}
	if (raw.policy !== "one-shot" && raw.policy !== "converge" && raw.policy !== "flow") {
		throw new ManifestError(source, '`policy` must be "one-shot", "converge", or "flow"');
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw new ManifestError(source, "`description` must be a string");
	}
	const description = typeof raw.description === "string" ? raw.description : undefined;
	const inputs = parseInputs(raw.inputs, source);

	if (raw.policy === "flow") {
		requireKeys(raw, new Set(["id", "policy", "description", "inputs", "steps"]), source);
		return {
			id: raw.id,
			...(description !== undefined && { description }),
			policy: "flow",
			inputs,
			steps: parseFlowSteps(raw.steps, source),
		};
	}

	const participants = parseParticipants(raw.participants, source);

	if (raw.policy === "one-shot") {
		requireKeys(
			raw,
			new Set(["id", "policy", "description", "inputs", "participants", "steps", "output"]),
			source,
		);
		// allowCheck=false guarantees no check steps, so the narrower OneShotStep[] holds.
		const steps = parseSteps(raw.steps, source, participants, false) as OneShotStep[];
		if (typeof raw.output !== "string" || !steps.some((s) => s.id === raw.output)) {
			throw new ManifestError(source, "`output` must name one of the steps");
		}
		return {
			id: raw.id,
			...(description !== undefined && { description }),
			policy: "one-shot",
			inputs,
			participants,
			steps,
			output: raw.output,
		};
	}

	requireKeys(
		raw,
		new Set(["id", "policy", "description", "inputs", "participants", "steps", "maxIterations"]),
		source,
	);
	const steps = parseSteps(raw.steps, source, participants, true);
	if (!steps.some((s) => s.kind === "check")) {
		throw new ManifestError(source, "a converge routine needs at least one `check` step (its convergence signal)");
	}
	if (raw.maxIterations !== undefined) {
		if (typeof raw.maxIterations !== "number" || !Number.isInteger(raw.maxIterations) || raw.maxIterations < 1) {
			throw new ManifestError(source, "`maxIterations` must be a positive integer");
		}
	}
	return {
		id: raw.id,
		...(description !== undefined && { description }),
		policy: "converge",
		inputs,
		participants,
		steps,
		...(typeof raw.maxIterations === "number" && { maxIterations: raw.maxIterations }),
	};
}
