// Validate the operator-supplied inputs against what the manifest declares.
// Returns clear, collected errors -- missing-required and unknown inputs are the
// two mistakes a first-time user makes, and the model's job is to make them
// obvious from `inspect` and from a refused run, not to guess.

import type { Manifest } from "./manifest.ts";

export type InputValidation = { ok: true; values: Record<string, string> } | { ok: false; errors: string[] };

export function validateInputs(manifest: Manifest, provided: Record<string, string>): InputValidation {
	const errors: string[] = [];
	const declared = manifest.inputs;

	for (const name of Object.keys(provided)) {
		if (!(name in declared)) {
			const known = Object.keys(declared);
			errors.push(
				`unknown input "${name}"${known.length > 0 ? ` (declared: ${known.join(", ")})` : " (this routine takes no inputs)"}`,
			);
		}
	}

	for (const [name, spec] of Object.entries(declared)) {
		if (spec.required && (provided[name] === undefined || provided[name] === "")) {
			errors.push(`missing required input "${name}"${spec.description ? ` -- ${spec.description}` : ""}`);
		}
	}

	if (errors.length > 0) return { ok: false, errors };

	const values: Record<string, string> = {};
	for (const name of Object.keys(declared)) {
		if (provided[name] !== undefined) values[name] = provided[name];
	}
	return { ok: true, values };
}
