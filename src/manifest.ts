// A manifest is the source of truth for a routine: its inputs, participants,
// steps, policy, prompts, and checks. The config layer only NAMES a routine and
// points at one of these; it never redeclares any of this. Keeping that boundary
// strict is the whole point of the model -- one place to read "what will run".
//
// Parsing rejects anything off-contract loudly, the same discipline the hardened
// runtime uses: an unknown field is a typo or a smuggled surface, never a silent
// passthrough.

export type Filesystem = "read-only" | "read-write" | "none";
export type Policy = "one-shot" | "converge";

const FILESYSTEMS = new Set<Filesystem>(["read-only", "read-write", "none"]);

// An input the operator supplies at run time. v1 is string-typed only; `required`
// defaults to true so a routine asks for what it needs unless explicitly optional.
export interface InputSpec {
	type: "string";
	required: boolean;
	description?: string;
}

// A named actor in the routine. `agent` is the adapter/model id (e.g. "claude").
// `filesystem` is the permission the run SHOULD grant it; the inspect view surfaces
// it so a reader knows the blast radius before running.
export interface Participant {
	id: string;
	agent: string;
	instructions: string;
	filesystem: Filesystem;
}

// One ordered unit of a one-shot routine. A `call` step invokes a participant with
// a rendered prompt; a `format` step assembles text (typically a prior step's
// output) without a model call.
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
export type Step = CallStep | FormatStep;

// A check the converge loop runs to decide "done": argv only (command + args),
// never a shell string, so there is nothing to quote-escape or inject.
export interface Check {
	command: string;
	args: string[];
}

export interface OneShotManifest {
	id: string;
	description?: string;
	policy: "one-shot";
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	steps: Step[];
	output: string;
}

// Converge declares its loop by REFERENCE to participant ids rather than fixed
// "implementer"/"reviewer" role names -- roles are examples of participant names,
// not a built-in vocabulary.
export interface ConvergeManifest {
	id: string;
	description?: string;
	policy: "converge";
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	loop: { implementer: string; reviewer: string };
	checks: Check[];
	maxIterations?: number;
}

export type Manifest = OneShotManifest | ConvergeManifest;

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
		const hasCall = s.call !== undefined;
		const hasFormat = s.format !== undefined;
		if (hasCall === hasFormat) {
			throw new ManifestError(where, "a step is exactly one of `call` or `format`");
		}
		if (hasCall) {
			requireKeys(s, new Set(["id", "call", "prompt"]), where);
			if (typeof s.call !== "string" || !(s.call in participants)) {
				throw new ManifestError(where, `\`call\` must name a participant (got ${JSON.stringify(s.call)})`);
			}
			if (typeof s.prompt !== "string" || !s.prompt) {
				throw new ManifestError(where, "`prompt` must be a non-empty string");
			}
			out.push({ id: s.id, kind: "call", call: s.call, prompt: s.prompt });
		} else {
			requireKeys(s, new Set(["id", "format"]), where);
			if (typeof s.format !== "string" || !s.format) {
				throw new ManifestError(where, "`format` must be a non-empty string");
			}
			out.push({ id: s.id, kind: "format", format: s.format });
		}
	}
	return out;
}

function parseChecks(raw: unknown, source: string): Check[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new ManifestError(source, "`checks` must be an array");
	return raw.map((c, i) => {
		const where = `${source}.checks[${i}]`;
		if (!isObject(c)) throw new ManifestError(where, "must be an object");
		requireKeys(c, new Set(["command", "args"]), where);
		if (typeof c.command !== "string" || !c.command) {
			throw new ManifestError(where, "`command` must be a non-empty string");
		}
		const args = c.args ?? [];
		if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
			throw new ManifestError(where, "`args` must be an array of strings");
		}
		return { command: c.command, args: args as string[] };
	});
}

export function parseManifest(raw: unknown, source: string): Manifest {
	if (!isObject(raw)) throw new ManifestError(source, "manifest must be an object");
	if (typeof raw.id !== "string" || !raw.id) {
		throw new ManifestError(source, "`id` must be a non-empty string");
	}
	if (raw.policy !== "one-shot" && raw.policy !== "converge") {
		throw new ManifestError(source, '`policy` must be "one-shot" or "converge"');
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw new ManifestError(source, "`description` must be a string");
	}
	const description = typeof raw.description === "string" ? raw.description : undefined;
	const inputs = parseInputs(raw.inputs, source);
	const participants = parseParticipants(raw.participants, source);

	if (raw.policy === "one-shot") {
		requireKeys(
			raw,
			new Set(["id", "policy", "description", "inputs", "participants", "steps", "output"]),
			source,
		);
		const steps = parseSteps(raw.steps, source, participants);
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
		new Set(["id", "policy", "description", "inputs", "participants", "loop", "checks", "maxIterations"]),
		source,
	);
	if (!isObject(raw.loop)) throw new ManifestError(source, "`loop` must be an object");
	requireKeys(raw.loop, new Set(["implementer", "reviewer"]), `${source}.loop`);
	for (const role of ["implementer", "reviewer"] as const) {
		const ref = raw.loop[role];
		if (typeof ref !== "string" || !(ref in participants)) {
			throw new ManifestError(`${source}.loop`, `\`${role}\` must name a participant`);
		}
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
		loop: { implementer: raw.loop.implementer as string, reviewer: raw.loop.reviewer as string },
		checks: parseChecks(raw.checks, source),
		...(typeof raw.maxIterations === "number" && { maxIterations: raw.maxIterations }),
	};
}
