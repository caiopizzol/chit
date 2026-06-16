// The single source of truth for which model names a built-in adapter structurally accepts.
// Three consumers derive from it: the config parser (the runtime guard -- reject impossible
// pairs like codex:sonnet before a run), the JSON Schema (editor hints, generated below), and
// later a `chit doctor` (real installed-CLI / account probes).
//
// This is a STRUCTURAL check only: "does this model name belong to this adapter's family". It
// CANNOT know whether the local CLI account actually has access to that model -- that is a live
// concern for `chit doctor`, not the schema. So custom adapters are left opaque, and the built-in
// patterns are kept permissive (full names via a prefix pattern) to avoid false rejections.

export interface BuiltInAdapterSpec {
	// Known model aliases, matched exactly. "default" (and an omitted model) always pass.
	models: string[];
	// Structural prefixes for full model names this adapter accepts (e.g. claude-sonnet-4-6).
	modelPatterns: RegExp[];
}

export const CLAUDE_EFFORTS = ["low", "medium", "high", "max"] as const;
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const BUILT_IN_ADAPTERS: Record<string, BuiltInAdapterSpec> = {
	claude: { models: ["default", "sonnet", "opus", "haiku", "fable"], modelPatterns: [/^claude-/] },
	codex: { models: ["default", "gpt-5.5", "gpt-5.4-mini"], modelPatterns: [/^gpt-/, /^o\d/] },
	gemini: { models: ["default"], modelPatterns: [/^gemini-/] },
};

export const BUILT_IN_ADAPTER_IDS = Object.keys(BUILT_IN_ADAPTERS);

export function isBuiltInAdapter(adapter: string): boolean {
	return adapter in BUILT_IN_ADAPTERS;
}

// Can a built-in adapter honor a participant's filesystem permission? codex exec has no
// no-tools mode, so a `none` participant cannot use codex -- the codex adapter throws at call
// time, so `chit doctor` uses this to catch the mismatch before a run rather than mid-run. Other
// built-ins map all three levels; a custom adapter is opaque (assumed capable).
export function adapterSupportsFilesystem(adapter: string, filesystem: string): boolean {
	if (adapter === "codex" && filesystem === "none") return false;
	return true;
}

// Does `model` structurally belong to a built-in `adapter`? "default" and the listed aliases pass,
// else it must match a known prefix pattern. A non-built-in adapter returns true (opaque).
export function isStructurallyValidModel(adapter: string, model: string): boolean {
	const spec = BUILT_IN_ADAPTERS[adapter];
	if (spec === undefined) return true;
	return spec.models.includes(model) || spec.modelPatterns.some((re) => re.test(model));
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The model alternatives for a shorthand pattern: aliases (escaped) plus each prefix pattern
// (its `^` anchor stripped, allowed to run to end) -- so "claude:claude-sonnet-4-6" validates.
function shorthandModelAlternation(spec: BuiltInAdapterSpec): string {
	const aliases = spec.models.map(escapeRegex);
	const patterns = spec.modelPatterns.map((re) => `${re.source.replace(/^\^/, "")}.*`);
	return [...aliases, ...patterns].join("|");
}

// Generate the JSON Schema definition for a profile value FROM the registry, so the schema file
// and the parser cannot drift (a test asserts the file equals this). Built-in adapters get strict
// per-adapter branches; a custom adapter is allowed only in object form with an opaque model.
export function buildProfileSchema(): Record<string, unknown> {
	const branches: unknown[] = [];
	for (const [adapter, spec] of Object.entries(BUILT_IN_ADAPTERS)) {
		branches.push({
			type: "string",
			pattern: `^${adapter}(:(${shorthandModelAlternation(spec)}))?$`,
			description: `${adapter} profile shorthand (e.g. "${adapter}" or "${adapter}:<model>")`,
		});
		branches.push({
			type: "object",
			additionalProperties: false,
			required: ["adapter"],
			properties: {
				adapter: { const: adapter },
				model: {
					type: "string",
					anyOf: [{ enum: spec.models }, ...spec.modelPatterns.map((re) => ({ pattern: re.source }))],
				},
				...(adapter === "claude" && { effort: { enum: [...CLAUDE_EFFORTS] } }),
				...(adapter === "codex" && { effort: { enum: [...CODEX_EFFORTS] } }),
			},
		});
	}
	// Custom adapter: object form only (no shorthand), model is opaque.
	branches.push({
		type: "object",
		additionalProperties: false,
		required: ["adapter"],
		properties: {
			adapter: { type: "string", minLength: 1, not: { enum: BUILT_IN_ADAPTER_IDS } },
			model: { type: "string" },
			effort: { type: "string", minLength: 1 },
		},
	});
	return {
		description: "A model binding: a built-in adapter shorthand/object, or a custom adapter in object form.",
		oneOf: branches,
	};
}
