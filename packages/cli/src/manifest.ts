// A routine is ONE shape: inputs + participants + ordered steps + optional repeat
// + optional output. There is no `policy` field -- behavior is DERIVED from the
// structure, so the user describes the work, not its execution category:
//
//   steps are `routine` steps                 -> composition (run them in order)
//   `repeat` present                          -> loop until its `until` condition holds
//                                                (checks pass, or a step's output equals X)
//   any read-write participant OR check step  -> runs in a git-worktree sandbox
//   pure read-only (call/format, maybe a loop) -> runs read-only in the cwd
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
// A human-input gate: pause, ask the operator one question, and feed their typed
// answer forward as this step's output ({{ steps.<id>.output }}). It produces text
// like call/format, but the text comes from a person, not a model. The ask step does not
// write the answer to its own receipt, but forwarding it into a sub-routine input persists it
// there like any input (see store.ts).
export interface AskStep {
	id: string;
	kind: "ask";
	ask: string;
}
export type Step = CallStep | FormatStep | CheckStep | RoutineStep | AskStep;

// A loop's exit condition. The runtime owns the LOOP; the routine declares WHEN it ends,
// so /goal, grilling, research-until-good, etc. are authored, not hardcoded:
//   "checks-pass"            -- every check step passed (deterministic; the proven default)
//   { step, equals }         -- a named step's output equals a string (e.g. an evaluator
//                               call returns "yes"); model- or human-judged convergence
export type RepeatCondition = "checks-pass" | { step: string; equals: string };
// The exit is one condition, OR `{ all: [...] }` requiring EVERY listed condition to hold.
// That lets a manifest make a model review BLOCKING, not advisory: converge only when the
// checks pass AND the critic step returns "pass". Still declared, still checkable.
export type RepeatUntil = RepeatCondition | { all: RepeatCondition[] };

export interface Repeat {
	until: RepeatUntil;
	maxIterations?: number;
}

// Time bounds, in minutes, with explicit "none" to opt out. High by default --
// the bound exists to catch a stuck call/run, not to cut off honest slow work.
// maxIterations is always kept regardless. Separate per-call vs whole-run bounds.
export interface Limits {
	callTimeoutMinutes?: number | "none";
	runTimeoutMinutes?: number | "none";
}

export interface Manifest {
	id: string;
	description?: string;
	inputs: Record<string, InputSpec>;
	participants: Record<string, Participant>;
	steps: Step[];
	repeat?: Repeat;
	output?: string;
	limits?: Limits;
}

const DEFAULT_CALL_TIMEOUT_MIN = 30;
const DEFAULT_RUN_TIMEOUT_MIN = 120;

// Effective per-call timeout in ms; undefined means no bound ("none").
export function effectiveCallTimeoutMs(m: Manifest): number | undefined {
	const v = m.limits?.callTimeoutMinutes ?? DEFAULT_CALL_TIMEOUT_MIN;
	return v === "none" ? undefined : v * 60_000;
}

// Effective whole-run wall-time in ms; undefined means no bound ("none").
export function effectiveRunTimeoutMs(m: Manifest): number | undefined {
	const v = m.limits?.runTimeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MIN;
	return v === "none" ? undefined : v * 60_000;
}

// --- derived behavior (the user never writes these) ---

export function isComposition(m: Manifest): boolean {
	// `ask` steps are neutral -- they may sit between routine steps (a decision gate)
	// without making a composition an execution. A composition is "has >=1 routine step
	// and every non-ask step is a routine".
	const nonAsk = m.steps.filter((s) => s.kind !== "ask");
	return nonAsk.length > 0 && nonAsk.every((s) => s.kind === "routine");
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
	if (Array.isArray(raw)) {
		const out: Record<string, InputSpec> = {};
		for (const [i, name] of raw.entries()) {
			if (typeof name !== "string" || !name) throw new ManifestError(`${source}.inputs[${i}]`, "must be a non-empty input name");
			out[name] = { type: "string", required: true };
		}
		return out;
	}
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
		requireKeys(spec, new Set(["agent", "profile", "instructions", "filesystem"]), where);
		if (spec.agent !== undefined && spec.profile !== undefined) {
			throw new ManifestError(where, "`agent` and `profile` are aliases; use one of them");
		}
		const agent = spec.profile ?? spec.agent;
		if (typeof agent !== "string" || !agent) {
			throw new ManifestError(where, "`profile` must be a non-empty string");
		}
		if (typeof spec.instructions !== "string" || !spec.instructions) {
			throw new ManifestError(where, "`instructions` must be a non-empty string");
		}
		if (typeof spec.filesystem !== "string" || !FILESYSTEMS.has(spec.filesystem as Filesystem)) {
			throw new ManifestError(where, `\`filesystem\` must be one of: ${[...FILESYSTEMS].join(", ")}`);
		}
		out[id] = { id, agent, instructions: spec.instructions, filesystem: spec.filesystem as Filesystem };
	}
	return out;
}

function parseCheckArray(raw: unknown, where: string): Check[] {
	if (typeof raw === "string") {
		if (!raw) throw new ManifestError(where, "`check` string must not be empty");
		return [{ command: "sh", args: ["-c", raw] }];
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new ManifestError(where, "`check` must be a command string or a non-empty array of commands");
	}
	return raw.map((c, i) => {
		const at = `${where}[${i}]`;
		if (typeof c === "string") {
			if (!c) throw new ManifestError(at, "check command string must not be empty");
			return { command: "sh", args: ["-c", c] };
		}
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
		const kinds = (["call", "format", "check", "routine", "ask"] as const).filter((k) => s[k] !== undefined);
		if (kinds.length !== 1) {
			throw new ManifestError(where, "a step is exactly one of `call`, `format`, `check`, `routine`, or `ask`");
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
		} else if (kind === "ask") {
			requireKeys(s, new Set(["id", "ask"]), where);
			if (typeof s.ask !== "string" || !s.ask) throw new ManifestError(where, "`ask` must be a non-empty question string");
			out.push({ id: s.id, kind: "ask", ask: s.ask });
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
	requireKeys(raw, new Set(["id", "description", "input", "inputs", "agents", "participants", "steps", "repeat", "output", "limits"]), source);

	if (raw.input !== undefined && raw.inputs !== undefined) {
		throw new ManifestError(source, "`input` and `inputs` are aliases; use one of them");
	}
	const inputRaw = raw.input !== undefined ? [raw.input] : raw.inputs;
	const inputs = parseInputs(inputRaw, source);
	if (raw.agents !== undefined && raw.participants !== undefined) {
		throw new ManifestError(source, "`agents` and `participants` are aliases; use one of them");
	}
	const participants = parseParticipants(raw.agents ?? raw.participants, source);
	const steps = parseSteps(raw.steps, source, participants);

	// Rule 1: no step mixing -- `routine` steps (a composition) OR call/format/check
	// (an execution), never both. `ask` steps are neutral and allowed in either.
	const routineCount = steps.filter((s) => s.kind === "routine").length;
	const execCount = steps.filter((s) => s.kind === "call" || s.kind === "format" || s.kind === "check").length;
	if (routineCount > 0 && execCount > 0) {
		throw new ManifestError(source, "steps must be either all `routine` steps (a composition) or call/format/check (an execution), not a mix");
	}
	const composition = routineCount > 0;

	// Rule 4: `ask` (human input) is supported only where execution pauses cleanly between
	// steps -- a single-pass text routine or a composition. It is NOT supported inside a
	// sandboxed routine (a check step or a read-write participant) NOR a loop (`repeat`),
	// where the converge executor re-runs steps and "ask once vs every iteration" is undefined.
	// Put the gate in the composition that calls this routine instead.
	const sandboxed = steps.some((s) => s.kind === "check") || Object.values(participants).some((p) => p.filesystem === "read-write");
	const looping = raw.repeat !== undefined;
	if (steps.some((s) => s.kind === "ask") && !composition && (sandboxed || looping)) {
		throw new ManifestError(
			source,
			"an `ask` step is not supported in a sandboxed or looping routine (it has a check step, a read-write participant, or a `repeat`). Put the ask in the composition that calls this routine, or in a single-pass read-only text routine.",
		);
	}

	// Rule 2: repeat declares a loop over an execution routine (never a composition) with an
	// exit condition. "checks-pass" needs >=1 check step as its signal; { step, equals } needs
	// the named step to exist AND an explicit maxIterations (a judged condition has no
	// deterministic termination, so the author must bound it). Looping is independent of the
	// sandbox: a loop that writes or checks runs in a worktree, a pure read-only loop in cwd.
	let repeat: Repeat | undefined;
	if (raw.repeat !== undefined) {
		if (!isObject(raw.repeat)) throw new ManifestError(`${source}.repeat`, "must be an object");
		requireKeys(raw.repeat, new Set(["until", "maxIterations"]), `${source}.repeat`);
		if (composition) throw new ManifestError(source, "`repeat` is not valid on a composition (a composition's sub-routines repeat themselves)");

		const mi = raw.repeat.maxIterations;
		if (mi !== undefined && (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1)) {
			throw new ManifestError(`${source}.repeat`, "`maxIterations` must be a positive integer");
		}

		// One condition: "checks-pass" or { step, equals } (the step must exist). The aggregate
		// requirements (a check step for checks-pass, an explicit maxIterations for a judged
		// condition) are enforced once over the whole set below, so they hold inside `all` too.
		const parseCondition = (rawCond: unknown, where: string): RepeatCondition => {
			if (rawCond === "checks-pass") return "checks-pass";
			if (isObject(rawCond) && !("all" in rawCond)) {
				requireKeys(rawCond, new Set(["step", "equals"]), where);
				if (typeof rawCond.step !== "string" || !rawCond.step) throw new ManifestError(where, "`step` must be a non-empty step id");
				if (typeof rawCond.equals !== "string") throw new ManifestError(where, "`equals` must be a string to compare the step's output against");
				if (!steps.some((s) => s.id === rawCond.step)) {
					throw new ManifestError(source, `\`repeat.until\` references step ${JSON.stringify(rawCond.step)}, which is not a step in this routine`);
				}
				return { step: rawCond.step, equals: rawCond.equals };
			}
			throw new ManifestError(where, '`until` condition must be "checks-pass" or { step, equals }');
		};

		const rawUntil = raw.repeat.until;
		let until: RepeatUntil;
		let conds: RepeatCondition[];
		if (isObject(rawUntil) && "all" in rawUntil) {
			requireKeys(rawUntil, new Set(["all"]), `${source}.repeat.until`);
			if (!Array.isArray(rawUntil.all) || rawUntil.all.length === 0) {
				throw new ManifestError(`${source}.repeat.until`, "`all` must be a non-empty array of conditions");
			}
			conds = rawUntil.all.map((c, i) => parseCondition(c, `${source}.repeat.until.all[${i}]`));
			until = { all: conds };
		} else {
			const cond = parseCondition(rawUntil, `${source}.repeat.until`);
			conds = [cond];
			until = cond;
		}

		if (conds.includes("checks-pass") && !steps.some((s) => s.kind === "check")) {
			throw new ManifestError(source, '`repeat.until: "checks-pass"` requires at least one `check` step (its convergence signal)');
		}
		if (conds.some((c) => typeof c === "object") && mi === undefined) {
			throw new ManifestError(source, "a `{ step, equals }` exit condition requires an explicit `maxIterations` (a judged condition has no guaranteed termination)");
		}

		repeat = { until, ...(typeof mi === "number" && { maxIterations: mi }) };
	}

	// Rule 3: output names a TEXT-producing step (call/format/routine), never a check or
	// an ask. An ask answer is an input to later steps, not the routine's product, and it
	// is kept out of the persisted receipt -- so it cannot be the run's output.
	let output: string | undefined;
	if (raw.output !== undefined) {
		if (typeof raw.output !== "string") throw new ManifestError(source, "`output` must be a string");
		const target = steps.find((s) => s.id === raw.output);
		if (target === undefined) throw new ManifestError(source, "`output` must name one of the steps");
		if (target.kind === "check") throw new ManifestError(source, "`output` cannot name a `check` step (it produces no text)");
		if (target.kind === "ask") throw new ManifestError(source, "`output` cannot name an `ask` step (its answer feeds later steps and is not persisted)");
		output = raw.output;
	}

	let limits: Limits | undefined;
	if (raw.limits !== undefined) {
		if (!isObject(raw.limits)) throw new ManifestError(`${source}.limits`, "must be an object");
		requireKeys(raw.limits, new Set(["callTimeoutMinutes", "runTimeoutMinutes"]), `${source}.limits`);
		const parseLimit = (v: unknown, name: string): number | "none" | undefined => {
			if (v === undefined) return undefined;
			if (v === "none") return "none";
			if (typeof v !== "number" || !(v > 0)) {
				throw new ManifestError(`${source}.limits`, `\`${name}\` must be a positive number of minutes or "none"`);
			}
			return v;
		};
		const call = parseLimit(raw.limits.callTimeoutMinutes, "callTimeoutMinutes");
		const run = parseLimit(raw.limits.runTimeoutMinutes, "runTimeoutMinutes");
		// A composition makes no direct calls of its own (its sub-routines do), so a
		// per-call bound here would be inert. Reject it instead of silently ignoring it;
		// `runTimeoutMinutes` is valid (it bounds the whole flow's wall-time).
		if (composition && call !== undefined) {
			throw new ManifestError(
				source,
				"`limits.callTimeoutMinutes` is not valid on a composition (it makes no direct calls -- set it on the sub-routines it calls). Use `runTimeoutMinutes` to bound the whole flow.",
			);
		}
		limits = {
			...(call !== undefined && { callTimeoutMinutes: call }),
			...(run !== undefined && { runTimeoutMinutes: run }),
		};
	}

	return {
		id: raw.id,
		...(typeof raw.description === "string" && { description: raw.description }),
		inputs,
		participants,
		steps,
		...(repeat !== undefined && { repeat }),
		...(output !== undefined && { output }),
		...(limits !== undefined && { limits }),
	};
}
