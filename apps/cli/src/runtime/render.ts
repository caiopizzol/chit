import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { InputType, NormalizedInput } from "@chit/core";

export class RuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeError";
	}
}

export interface PreparedInput {
	type: InputType;
	optional: boolean;
	present: boolean;
	rendered: string;
}

export type PreparedInputs = Record<string, PreparedInput>;

const TEMPLATE_REF_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function prepareInputs(
	declared: Record<string, NormalizedInput>,
	provided: Record<string, unknown>,
	invocationCwd: string,
): PreparedInputs {
	for (const k of Object.keys(provided)) {
		if (!(k in declared)) throw new RuntimeError(`unknown input "${k}"`);
	}

	const out: PreparedInputs = {};
	for (const [name, schema] of Object.entries(declared)) {
		const value = provided[name];
		if (value === undefined) {
			if (!schema.optional) {
				throw new RuntimeError(`missing required input "${name}"`);
			}
			out[name] = { type: schema.type, optional: true, present: false, rendered: "" };
			continue;
		}

		if (schema.type === "string") {
			if (typeof value !== "string") {
				throw new RuntimeError(`input "${name}" must be a string`);
			}
			out[name] = { type: "string", optional: schema.optional, present: true, rendered: value };
		} else {
			if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
				throw new RuntimeError(`input "${name}" must be an array of file path strings`);
			}
			out[name] = {
				type: "file[]",
				optional: schema.optional,
				present: true,
				rendered: renderFilePaths(value as string[], invocationCwd, name),
			};
		}
	}
	return out;
}

function renderFilePaths(paths: string[], invocationCwd: string, inputName: string): string {
	const resolved: string[] = [];
	for (const p of paths) {
		const abs = isAbsolute(p) ? p : resolve(invocationCwd, p);
		if (!existsSync(abs)) {
			throw new RuntimeError(`input "${inputName}" references missing file: ${p}`);
		}
		resolved.push(abs);
	}
	return resolved.join("\n");
}

export function renderTemplate(
	template: string,
	inputs: PreparedInputs,
	stepOutputs: Record<string, string>,
): string {
	return template.replace(TEMPLATE_REF_RE, (_match, captured: string) => {
		const parts = captured.split(".");
		if (parts[0] === "inputs") {
			const name = parts[1];
			if (name === undefined) {
				throw new RuntimeError(`internal: malformed input ref "${captured}"`);
			}
			const input = inputs[name];
			if (input === undefined) {
				throw new RuntimeError(`internal: input "${name}" not prepared`);
			}
			return input.rendered;
		}
		if (parts[0] === "steps") {
			const name = parts[1];
			if (name === undefined) {
				throw new RuntimeError(`internal: malformed step ref "${captured}"`);
			}
			const out = stepOutputs[name];
			if (out === undefined) {
				throw new RuntimeError(`internal: step "${name}" output not available`);
			}
			return out;
		}
		throw new RuntimeError(`internal: unknown template prefix "${parts[0]}"`);
	});
}
