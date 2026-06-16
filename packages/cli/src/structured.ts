// Structured call output. A `call` step may declare `json: { schema }`. When present, the
// model's text output is parsed as JSON and validated against the schema. Valid -> the step's
// output becomes the normalized JSON and the parsed value is exposed to a `{ step, path, equals }`
// repeat condition. Invalid -> the validation error becomes the step output, so a loop can show
// the model exactly what to fix on the next iteration. That turns the brittle "emit one exact
// string" verdict into a typed contract with self-correcting feedback.
//
// The validator is deliberately a SUBSET of JSON Schema (object/array/string/number/integer/
// boolean, with properties/required/additionalProperties/items/enum). Unknown keywords are
// REJECTED at parse time rather than silently ignored, so a declared schema never overstates
// what is enforced. Keeping it a subset keeps the runtime dependency-free; if the subset ever
// proves too small, swap a full validator in here -- nothing else imports the validation logic.

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean";

export interface JsonSchema {
	type: JsonType;
	// object
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
	// array
	items?: JsonSchema;
	// scalar (string/number/integer/boolean)
	enum?: (string | number | boolean)[];
}

const TYPES = new Set<JsonType>(["object", "array", "string", "number", "integer", "boolean"]);
const SCALAR_TYPES = new Set<JsonType>(["string", "number", "integer", "boolean"]);
const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum"]);

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Validate that a user-declared schema uses only the supported subset, returning the normalized
// JsonSchema. `fail(where, detail)` throws (the caller maps it to its own error type, e.g.
// ManifestError) so this module stays a leaf with no import cycle back into the manifest.
export function parseJsonSchema(
	raw: unknown,
	where: string,
	fail: (where: string, detail: string) => never,
): JsonSchema {
	if (!isObject(raw)) fail(where, "a schema must be an object");
	for (const k of Object.keys(raw)) {
		if (!SCHEMA_KEYWORDS.has(k))
			fail(where, `unsupported schema keyword "${k}" (supported: ${[...SCHEMA_KEYWORDS].join(", ")})`);
	}
	const type = raw.type;
	if (typeof type !== "string" || !TYPES.has(type as JsonType))
		fail(where, `\`type\` must be one of: ${[...TYPES].join(", ")}`);
	const t = type as JsonType;
	const schema: JsonSchema = { type: t };

	if (raw.enum !== undefined) {
		if (!SCALAR_TYPES.has(t)) fail(where, "`enum` is only supported on a string/number/integer/boolean schema");
		if (!Array.isArray(raw.enum) || raw.enum.length === 0) fail(`${where}.enum`, "must be a non-empty array");
		for (const [i, v] of raw.enum.entries()) {
			if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
				fail(`${where}.enum[${i}]`, "must be a string, number, or boolean");
		}
		schema.enum = raw.enum as (string | number | boolean)[];
	}

	if (t === "object") {
		if (raw.properties !== undefined) {
			if (!isObject(raw.properties)) fail(`${where}.properties`, "must be an object");
			const props: Record<string, JsonSchema> = {};
			for (const [k, v] of Object.entries(raw.properties))
				props[k] = parseJsonSchema(v, `${where}.properties.${k}`, fail);
			schema.properties = props;
		}
		if (raw.required !== undefined) {
			if (!Array.isArray(raw.required) || raw.required.some((r) => typeof r !== "string"))
				fail(`${where}.required`, "must be an array of property names");
			if (schema.properties !== undefined) {
				for (const r of raw.required as string[]) {
					if (!(r in schema.properties)) fail(`${where}.required`, `"${r}" is not declared in \`properties\``);
				}
			}
			schema.required = raw.required as string[];
		}
		if (raw.additionalProperties !== undefined) {
			if (typeof raw.additionalProperties !== "boolean") fail(`${where}.additionalProperties`, "must be a boolean");
			schema.additionalProperties = raw.additionalProperties;
		}
	} else if (raw.properties !== undefined || raw.required !== undefined || raw.additionalProperties !== undefined) {
		fail(where, "`properties`, `required`, and `additionalProperties` are only valid on an `object` schema");
	}

	if (t === "array") {
		if (raw.items !== undefined) schema.items = parseJsonSchema(raw.items, `${where}.items`, fail);
	} else if (raw.items !== undefined) {
		fail(where, "`items` is only valid on an `array` schema");
	}

	return schema;
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

// Validate a parsed JSON value against a subset schema. Returns human-readable errors (empty =
// valid), each reading "<path>: <problem>" so they double as model-facing feedback.
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): string[] {
	const typeOk = (v: unknown, ty: JsonType): boolean =>
		ty === "object"
			? isObject(v)
			: ty === "array"
				? Array.isArray(v)
				: ty === "string"
					? typeof v === "string"
					: ty === "number"
						? typeof v === "number" && Number.isFinite(v)
						: ty === "integer"
							? typeof v === "number" && Number.isInteger(v)
							: typeof v === "boolean";

	if (!typeOk(value, schema.type)) return [`${path}: expected ${schema.type}, got ${describe(value)}`];

	const errors: string[] = [];
	if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) {
		errors.push(
			`${path}: ${JSON.stringify(value)} is not one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
		);
	}
	if (schema.type === "object") {
		const obj = value as Record<string, unknown>;
		for (const r of schema.required ?? []) {
			if (!(r in obj)) errors.push(`${path}: missing required property "${r}"`);
		}
		if (schema.properties !== undefined) {
			for (const [k, sub] of Object.entries(schema.properties)) {
				if (k in obj) errors.push(...validateJson(obj[k], sub, `${path}.${k}`));
			}
			if (schema.additionalProperties === false) {
				for (const k of Object.keys(obj)) {
					if (!(k in schema.properties)) errors.push(`${path}: unexpected property "${k}"`);
				}
			}
		}
	}
	if (schema.type === "array" && schema.items !== undefined) {
		const items = schema.items;
		for (const [i, el] of (value as unknown[]).entries()) {
			errors.push(...validateJson(el, items, `${path}[${i}]`));
		}
	}
	return errors;
}

// Strip a single ``` or ```lang code fence if the model wrapped its JSON in one. Anything else
// is left to JSON.parse (and a non-JSON wrapper becomes a useful "not valid JSON" error).
function extractJson(raw: string): string {
	const t = raw.trim();
	const fence = /^```[A-Za-z0-9]*\n([\s\S]*?)\n```$/.exec(t);
	return fence !== null ? (fence[1] as string).trim() : t;
}

export type StructuredResult = { ok: true; value: unknown; normalized: string } | { ok: false; error: string };

// Parse a model's text output as JSON and validate it against the schema.
export function evaluateStructured(rawOutput: string, schema: JsonSchema): StructuredResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJson(rawOutput));
	} catch (e) {
		return { ok: false, error: `output is not valid JSON: ${(e as Error).message}` };
	}
	const errors = validateJson(parsed, schema);
	if (errors.length > 0)
		return { ok: false, error: `output did not match the declared schema:\n${errors.map((e) => `- ${e}`).join("\n")}` };
	return { ok: true, value: parsed, normalized: JSON.stringify(parsed, null, 2) };
}

// Read a dot-path (e.g. "decision.ready") from a parsed value. Returns undefined if any segment
// is missing or traverses a non-object. Intentionally tiny: object keys only, no arrays/wildcards/
// filters; the caller compares the leaf with === against a scalar.
export function readPath(value: unknown, path: string): unknown {
	let cur: unknown = value;
	for (const seg of path.split(".")) {
		if (!isObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}
