import type {
	FilesystemPermission,
	InputType,
	NormalizedInput,
	NormalizedManifest,
	NormalizedParticipant,
	NormalizedPolicy,
	NormalizedStep,
	SessionPolicy,
	TemplateRef,
} from "./types.ts";

export class ManifestError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "ManifestError";
	}
}

const ALLOWED_TOP_KEYS = new Set([
	"schema",
	"id",
	"description",
	"inputs",
	"requires",
	"participants",
	"steps",
	"output",
	"policy",
]);
const REQUIRED_TOP_KEYS = [
	"schema",
	"id",
	"description",
	"inputs",
	"participants",
	"steps",
	"output",
] as const;

const ID_RE = /^[a-z][a-z0-9-]*$/;
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Reserved JS object-prototype keys. Input names, participant ids, and step
// ids become keys in plain objects (here, and in the runtime's records/outputs
// maps), so allowing these would let a user-authored manifest pollute
// prototypes. Rejected at parse so every surface is protected.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

const ALLOWED_INPUT_KEYS = new Set(["type", "optional"]);
const ALLOWED_INPUT_TYPES: ReadonlySet<string> = new Set(["string", "file[]"]);

const ALLOWED_PARTICIPANT_KEYS = new Set(["agent", "instructions", "session", "permissions"]);
const REQUIRED_PARTICIPANT_KEYS = ["agent", "instructions", "session"] as const;
// Exported as the single source of the participant/role vocabulary: the config
// role parser reuses these so a role and a participant validate session and
// filesystem identically (no drift between the two).
export const ALLOWED_SESSIONS: ReadonlySet<string> = new Set([
	"stateless",
	"per_topology",
	"per_scope",
]);
const ALLOWED_PERMISSION_KEYS = new Set(["filesystem"]);
export const ALLOWED_FILESYSTEM_VALUES: ReadonlySet<string> = new Set(["read_only", "write"]);

const ALLOWED_CALL_KEYS = new Set(["call", "prompt"]);
const ALLOWED_FORMAT_KEYS = new Set(["format"]);

const ALLOWED_POLICY_KINDS: ReadonlySet<string> = new Set(["one-shot", "loop"]);
const ALLOWED_LOOP_POLICY_KEYS = new Set(["kind", "implementStep", "reviewStep", "maxIterations"]);

const TEMPLATE_REF_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reqNonEmptyString(v: unknown, path: string): string {
	if (typeof v !== "string" || !v) throw new ManifestError(path, "must be a non-empty string");
	return v;
}

function parseInputs(raw: unknown): Record<string, NormalizedInput> {
	if (!isObject(raw)) throw new ManifestError("inputs", "must be an object");
	if (Object.keys(raw).length === 0)
		throw new ManifestError("inputs", "must define at least one input");

	const out: Record<string, NormalizedInput> = {};
	for (const [name, val] of Object.entries(raw)) {
		const path = `inputs.${name}`;
		if (!IDENT_RE.test(name)) throw new ManifestError(path, "input name must be an identifier");
		if (RESERVED_IDS.has(name))
			throw new ManifestError(path, "input name must not be a reserved name");
		if (!isObject(val)) throw new ManifestError(path, "must be an object");
		for (const k of Object.keys(val)) {
			if (!ALLOWED_INPUT_KEYS.has(k)) throw new ManifestError(path, `unknown field "${k}"`);
		}
		if (!("type" in val)) throw new ManifestError(path, "missing `type`");

		const type = val.type;
		if (typeof type !== "string" || !ALLOWED_INPUT_TYPES.has(type)) {
			throw new ManifestError(
				`${path}.type`,
				`must be one of: ${[...ALLOWED_INPUT_TYPES].join(", ")}`,
			);
		}

		let optional = false;
		if ("optional" in val) {
			if (typeof val.optional !== "boolean")
				throw new ManifestError(`${path}.optional`, "must be a boolean");
			optional = val.optional;
		}

		out[name] = { type: type as InputType, optional };
	}
	return out;
}

function parseRequires(raw: unknown): Record<string, true> {
	if (raw === undefined) return {};
	if (!isObject(raw)) throw new ManifestError("requires", "must be an object");

	const out: Record<string, true> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v !== true) {
			throw new ManifestError(
				`requires.${k}`,
				"must be `true` (positive requirements only; absence means not required)",
			);
		}
		out[k] = true;
	}
	return out;
}

function parseParticipants(raw: unknown): Record<string, NormalizedParticipant> {
	if (!isObject(raw)) throw new ManifestError("participants", "must be an object");
	if (Object.keys(raw).length === 0)
		throw new ManifestError("participants", "must define at least one participant");

	const out: Record<string, NormalizedParticipant> = {};
	for (const [name, val] of Object.entries(raw)) {
		const path = `participants.${name}`;
		if (!IDENT_RE.test(name)) throw new ManifestError(path, "participant id must be an identifier");
		if (RESERVED_IDS.has(name))
			throw new ManifestError(path, "participant id must not be a reserved name");
		if (!isObject(val)) throw new ManifestError(path, "must be an object");
		for (const k of Object.keys(val)) {
			if (!ALLOWED_PARTICIPANT_KEYS.has(k)) throw new ManifestError(path, `unknown field "${k}"`);
		}
		for (const k of REQUIRED_PARTICIPANT_KEYS) {
			if (!(k in val)) throw new ManifestError(path, `missing \`${k}\``);
		}

		const agent = reqNonEmptyString(val.agent, `${path}.agent`);
		const instructions = reqNonEmptyString(val.instructions, `${path}.instructions`);

		const session = val.session;
		if (typeof session !== "string" || !ALLOWED_SESSIONS.has(session)) {
			throw new ManifestError(
				`${path}.session`,
				`must be one of: ${[...ALLOWED_SESSIONS].join(", ")}`,
			);
		}

		let filesystem: FilesystemPermission = "read_only";
		if ("permissions" in val) {
			const perms = val.permissions;
			if (!isObject(perms)) throw new ManifestError(`${path}.permissions`, "must be an object");
			for (const k of Object.keys(perms)) {
				if (!ALLOWED_PERMISSION_KEYS.has(k))
					throw new ManifestError(`${path}.permissions`, `unknown field "${k}"`);
			}
			if ("filesystem" in perms) {
				const fs = perms.filesystem;
				if (typeof fs !== "string" || !ALLOWED_FILESYSTEM_VALUES.has(fs)) {
					throw new ManifestError(
						`${path}.permissions.filesystem`,
						`must be one of: ${[...ALLOWED_FILESYSTEM_VALUES].join(", ")}`,
					);
				}
				filesystem = fs as FilesystemPermission;
			}
		}

		out[name] = {
			agent,
			instructions,
			session: session as SessionPolicy,
			permissions: { filesystem },
		};
	}
	return out;
}

function extractRefs(
	template: string,
	path: string,
	inputs: Record<string, NormalizedInput>,
	stepIds: Set<string>,
	selfStepId: string,
): TemplateRef[] {
	const refs: TemplateRef[] = [];
	const seen = new Set<string>();

	TEMPLATE_REF_RE.lastIndex = 0;
	let match: RegExpExecArray | null = TEMPLATE_REF_RE.exec(template);
	while (match !== null) {
		const ref = match[1];
		if (ref === undefined) {
			match = TEMPLATE_REF_RE.exec(template);
			continue;
		}
		if (!seen.has(ref)) {
			seen.add(ref);
			const parts = ref.split(".");
			if (parts[0] === "inputs") {
				if (parts.length !== 2 || !parts[1]) {
					throw new ManifestError(
						path,
						`invalid template reference "${ref}" (expected inputs.<name>)`,
					);
				}
				const name = parts[1];
				if (!(name in inputs))
					throw new ManifestError(path, `template references unknown input "${name}"`);
				refs.push({ kind: "input", name });
			} else if (parts[0] === "steps") {
				if (parts.length !== 3 || !parts[1] || parts[2] !== "output") {
					throw new ManifestError(
						path,
						`invalid template reference "${ref}" (expected steps.<id>.output)`,
					);
				}
				const name = parts[1];
				if (!stepIds.has(name))
					throw new ManifestError(path, `template references unknown step "${name}"`);
				if (name === selfStepId)
					throw new ManifestError(path, `step "${selfStepId}" references its own output`);
				refs.push({ kind: "step_output", name });
			} else {
				throw new ManifestError(
					path,
					`invalid template reference "${ref}" (must start with inputs. or steps.)`,
				);
			}
		}
		match = TEMPLATE_REF_RE.exec(template);
	}

	// Reject anything that looks like a template tag but didn't match the strict
	// regex above (filters, unclosed tags, stray closes, empty tags). Strip the
	// validated matches and check the remainder for leftover `{{` or `}}`.
	const remainder = template.replace(TEMPLATE_REF_RE, "");
	const openIdx = remainder.indexOf("{{");
	if (openIdx >= 0) {
		const snippet = remainder.slice(openIdx, Math.min(openIdx + 40, remainder.length));
		const ellipsis = remainder.length > openIdx + 40 ? "..." : "";
		throw new ManifestError(
			path,
			`malformed template tag near "${snippet}${ellipsis}" (only "{{ inputs.<name> }}" and "{{ steps.<id>.output }}" are allowed)`,
		);
	}
	const closeIdx = remainder.indexOf("}}");
	if (closeIdx >= 0) {
		throw new ManifestError(path, `stray "}}" without a matching "{{"`);
	}

	return refs;
}

function parseStep(
	raw: unknown,
	stepId: string,
	participants: Record<string, NormalizedParticipant>,
	inputs: Record<string, NormalizedInput>,
	stepIds: Set<string>,
): NormalizedStep {
	const path = `steps.${stepId}`;
	if (!isObject(raw)) throw new ManifestError(path, "must be an object");

	const hasCall = "call" in raw;
	const hasFormat = "format" in raw;
	if (hasCall && hasFormat)
		throw new ManifestError(path, "must have either `call` or `format`, not both");
	if (!hasCall && !hasFormat) throw new ManifestError(path, "must have either `call` or `format`");

	if (hasCall) {
		for (const k of Object.keys(raw)) {
			if (!ALLOWED_CALL_KEYS.has(k)) throw new ManifestError(path, `unknown field "${k}"`);
		}
		if (!("prompt" in raw)) throw new ManifestError(path, "`call` step missing `prompt`");
		const call = reqNonEmptyString(raw.call, `${path}.call`);
		if (!(call in participants)) {
			throw new ManifestError(`${path}.call`, `unknown participant "${call}"`);
		}
		const prompt = reqNonEmptyString(raw.prompt, `${path}.prompt`);
		const refs = extractRefs(prompt, `${path}.prompt`, inputs, stepIds, stepId);
		return { kind: "call", call, prompt, refs };
	}

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_FORMAT_KEYS.has(k)) throw new ManifestError(path, `unknown field "${k}"`);
	}
	const format = reqNonEmptyString(raw.format, `${path}.format`);
	const refs = extractRefs(format, `${path}.format`, inputs, stepIds, stepId);
	return { kind: "format", format, refs };
}

function parseSteps(
	raw: unknown,
	participants: Record<string, NormalizedParticipant>,
	inputs: Record<string, NormalizedInput>,
): Record<string, NormalizedStep> {
	if (!isObject(raw)) throw new ManifestError("steps", "must be an object");
	const stepIds = new Set(Object.keys(raw));
	if (stepIds.size === 0) throw new ManifestError("steps", "must define at least one step");

	for (const stepId of stepIds) {
		if (!IDENT_RE.test(stepId))
			throw new ManifestError(`steps.${stepId}`, "step id must be an identifier");
		if (RESERVED_IDS.has(stepId))
			throw new ManifestError(`steps.${stepId}`, "step id must not be a reserved name");
	}

	const out: Record<string, NormalizedStep> = {};
	for (const [stepId, stepRaw] of Object.entries(raw)) {
		out[stepId] = parseStep(stepRaw, stepId, participants, inputs, stepIds);
	}
	return out;
}

// The execution policy. Absent normalizes to one-shot (a single DAG pass) so
// downstream code never sees `undefined`. A loop policy names the implementer
// and reviewer call steps and an optional iteration budget; the verdict contract
// is fixed in the loop driver and is deliberately NOT configurable here.
function parsePolicy(raw: unknown, steps: Record<string, NormalizedStep>): NormalizedPolicy {
	if (raw === undefined) return { kind: "one-shot" };
	if (!isObject(raw)) throw new ManifestError("policy", "must be an object");

	const kind = raw.kind;
	if (typeof kind !== "string" || !ALLOWED_POLICY_KINDS.has(kind)) {
		throw new ManifestError("policy.kind", 'must be "one-shot" or "loop"');
	}

	if (kind === "one-shot") {
		for (const k of Object.keys(raw)) {
			if (k !== "kind") throw new ManifestError(`policy.${k}`, "unknown field for one-shot policy");
		}
		return { kind: "one-shot" };
	}

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_LOOP_POLICY_KEYS.has(k))
			throw new ManifestError(`policy.${k}`, "unknown field for loop policy");
	}

	const requireCallStep = (value: unknown, field: string): string => {
		const id = reqNonEmptyString(value, `policy.${field}`);
		const step = steps[id];
		if (!step) throw new ManifestError(`policy.${field}`, `references unknown step "${id}"`);
		if (step.kind !== "call")
			throw new ManifestError(`policy.${field}`, `step "${id}" must be a call step`);
		return id;
	};

	const implementStep = requireCallStep(raw.implementStep, "implementStep");
	const reviewStep = requireCallStep(raw.reviewStep, "reviewStep");

	const policy: NormalizedPolicy = { kind: "loop", implementStep, reviewStep };
	if (raw.maxIterations !== undefined) {
		const n = raw.maxIterations;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
			throw new ManifestError("policy.maxIterations", "must be an integer >= 1");
		}
		policy.maxIterations = n;
	}
	return policy;
}

// Derive the surface capabilities a manifest needs from its inputs and
// participants. Exported because resolveManifest RE-runs it after resolution: a
// participant that references a role gets its session from the role, which parse
// (role-library-free) cannot see, so a per_scope session can be hidden until
// resolution. The participant type is widened to an optional session so it accepts
// both a parsed spec (session may be absent on a role ref) and a resolved
// participant (session concrete).
export function computeInferredRequires(
	inputs: Record<string, { type: InputType }>,
	participants: Record<string, { session?: SessionPolicy }>,
): Record<string, true> {
	const out: Record<string, true> = {};
	for (const input of Object.values(inputs)) {
		if (input.type === "file[]") out.can_pass_files = true;
	}
	for (const p of Object.values(participants)) {
		if (p.session === "per_scope") out.can_provide_stable_scope = true;
	}
	return out;
}

function buildDependencies(steps: Record<string, NormalizedStep>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [id, step] of Object.entries(steps)) {
		const seen = new Set<string>();
		const deps: string[] = [];
		for (const ref of step.refs) {
			if (ref.kind === "step_output" && !seen.has(ref.name)) {
				seen.add(ref.name);
				deps.push(ref.name);
			}
		}
		out[id] = deps;
	}
	return out;
}

function topologicalSort(deps: Record<string, string[]>): string[][] {
	const ids = Object.keys(deps);
	const inDegree: Record<string, number> = {};
	const dependents: Record<string, string[]> = {};
	for (const id of ids) {
		inDegree[id] = 0;
		dependents[id] = [];
	}
	for (const [id, ds] of Object.entries(deps)) {
		for (const d of ds) {
			inDegree[id] = (inDegree[id] ?? 0) + 1;
			const list = dependents[d];
			if (list) list.push(id);
		}
	}

	const levels: string[][] = [];
	let frontier = ids.filter((id) => (inDegree[id] ?? 0) === 0).sort();
	let visited = 0;
	while (frontier.length > 0) {
		levels.push([...frontier]);
		const next: string[] = [];
		for (const id of frontier) {
			visited++;
			for (const d of dependents[id] ?? []) {
				const remaining = (inDegree[d] ?? 0) - 1;
				inDegree[d] = remaining;
				if (remaining === 0) next.push(d);
			}
		}
		next.sort();
		frontier = next;
	}

	if (visited < ids.length) {
		const remaining = ids.filter((id) => (inDegree[id] ?? 0) > 0).sort();
		throw new ManifestError("steps", `cyclic dependency among: ${remaining.join(", ")}`);
	}
	return levels;
}

export function parseManifest(raw: unknown): NormalizedManifest {
	if (!isObject(raw)) throw new ManifestError("$", "manifest must be a JSON object");

	for (const k of Object.keys(raw)) {
		if (!ALLOWED_TOP_KEYS.has(k)) throw new ManifestError(k, "unknown top-level field");
	}
	for (const k of REQUIRED_TOP_KEYS) {
		if (!(k in raw)) throw new ManifestError(k, "missing required field");
	}

	if (raw.schema !== 1) throw new ManifestError("schema", "must be 1");

	const id = reqNonEmptyString(raw.id, "id");
	if (!ID_RE.test(id)) {
		throw new ManifestError(
			"id",
			"must be a kebab-case slug (lowercase letters, digits, hyphens; starts with a letter)",
		);
	}

	const description = reqNonEmptyString(raw.description, "description");

	const inputs = parseInputs(raw.inputs);
	const declaredRequires = parseRequires(raw.requires);
	const participants = parseParticipants(raw.participants);
	const steps = parseSteps(raw.steps, participants, inputs);

	const output = reqNonEmptyString(raw.output, "output");
	if (!(output in steps)) {
		throw new ManifestError("output", `references unknown step "${output}"`);
	}

	const policy = parsePolicy(raw.policy, steps);

	const inferredRequires = computeInferredRequires(inputs, participants);
	const requires: Record<string, true> = { ...inferredRequires, ...declaredRequires };

	const dependencies = buildDependencies(steps);
	const executionOrder = topologicalSort(dependencies);

	return {
		schema: 1,
		id,
		description,
		inputs,
		declaredRequires,
		inferredRequires,
		requires,
		participants,
		steps,
		output,
		policy,
		dependencies,
		executionOrder,
	};
}
