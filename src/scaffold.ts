// `chit init`: scaffold a runnable routine so a newcomer never hand-writes the JSON.
// It writes a manifest from a template under examples/, registers it in chit.config.json
// (creating the config if absent), and returns next-step hints. The generated manifest
// is a real, parseable, runnable routine -- the scaffold test resolves and runs it.
//
// Templates map to the three execution shapes a first routine is likely to want:
//   text   -- read-only call + format -> text output (runs in your cwd, no sandbox)
//   loop   -- builder + critic + a check, repeat until it passes (sandboxed)
//   check  -- a single check command, sandboxed, repeat until it passes

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Template = "text" | "loop" | "check";

export const TEMPLATES: Template[] = ["text", "loop", "check"];

// Same rule the config loader enforces, so a scaffolded id is always valid.
const ROUTINE_ID_RE = /^[a-z][a-z0-9-]*$/;

// A placeholder check that passes (so a fresh scaffold runs green) and documents, via
// its own argument, that the user should swap in a real command. `sh -c "true # ..."`
// runs `true` and treats the rest as a comment.
const PLACEHOLDER_CHECK = { command: "sh", args: ["-c", "true # replace with your real check, e.g. bun test"] };

function textManifest(id: string): unknown {
	return {
		id,
		description: "Turn an input into text, grounded in the repo (read-only, runs in your cwd).",
		inputs: { topic: { type: "string", required: true, description: "what to work on" } },
		participants: {
			assistant: {
				agent: "claude",
				instructions: "You are a careful assistant. Inspect the repo at your cwd read-only to ground your answer. You write nothing.",
				filesystem: "read-only",
			},
		},
		steps: [
			{ id: "respond", call: "assistant", prompt: "Topic:\n{{ inputs.topic }}\n\nRespond concisely, grounded in the repo." },
			{ id: "out", format: "{{ steps.respond.output }}" },
		],
		output: "out",
	};
}

function loopManifest(id: string): unknown {
	return {
		id,
		description: "Implement a change, review it, and verify with a check until it passes (sandboxed).",
		inputs: { task: { type: "string", required: true, description: "the change to make" } },
		participants: {
			builder: {
				agent: "claude",
				instructions: "You implement a small, well-scoped change and keep going until the check passes.",
				filesystem: "read-write",
			},
			critic: {
				agent: "claude",
				instructions: "You review the diff for correctness and scope. You do not edit files.",
				filesystem: "read-only",
			},
		},
		steps: [
			{
				id: "build",
				call: "builder",
				prompt: "Task:\n{{ inputs.task }}\n\nIteration {{ iteration }}.\nFailing check output:\n{{ steps.verify.output }}\n\nMake the smallest change toward passing the check.",
			},
			{ id: "critique", call: "critic", prompt: "Review the diff:\n{{ diff }}\n\nCall out correctness and scope problems. Be brief. Do not edit files." },
			{ id: "verify", check: [PLACEHOLDER_CHECK] },
		],
		repeat: { until: "checks-pass", maxIterations: 3 },
	};
}

function checkManifest(id: string): unknown {
	return {
		id,
		description: "Run a check command in a sandbox until it passes.",
		inputs: {},
		steps: [{ id: "verify", check: [PLACEHOLDER_CHECK] }],
		repeat: { until: "checks-pass", maxIterations: 1 },
	};
}

function manifestFor(id: string, template: Template): unknown {
	if (template === "loop") return loopManifest(id);
	if (template === "check") return checkManifest(id);
	return textManifest(id);
}

export interface ScaffoldResult {
	manifestPath: string; // relative, e.g. examples/review.json
	createdConfig: boolean;
	template: Template;
	inputHint?: string; // e.g. --input topic="..."
}

const INPUT_HINTS: Record<Template, string | undefined> = {
	text: '--input topic="..."',
	loop: '--input task="..."',
	check: undefined,
};

export function scaffoldRoutine(cwd: string, name: string, template: Template): ScaffoldResult {
	if (!ROUTINE_ID_RE.test(name)) {
		throw new Error(`routine name must be kebab-case and start with a letter (got ${JSON.stringify(name)})`);
	}

	// Load-or-create the config (raw JSON, so existing entries are preserved verbatim).
	const configPath = join(cwd, "chit.config.json");
	let config: { routines?: Record<string, unknown> } & Record<string, unknown>;
	let createdConfig = false;
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (e) {
			throw new Error(`chit.config.json is not valid JSON: ${(e as Error).message}`);
		}
		if (config.routines === undefined) config.routines = {};
	} else {
		config = { routines: {} };
		createdConfig = true;
	}
	const routines = config.routines as Record<string, unknown>;
	if (routines[name] !== undefined) {
		throw new Error(`routine ${JSON.stringify(name)} already exists in chit.config.json`);
	}

	const manifestPath = `examples/${name}.json`;
	const manifestAbs = join(cwd, "examples", `${name}.json`);
	if (existsSync(manifestAbs)) {
		throw new Error(`${manifestPath} already exists -- pick another name or remove it first`);
	}

	const manifest = manifestFor(name, template) as { description?: string };
	mkdirSync(join(cwd, "examples"), { recursive: true });
	writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, "\t")}\n`);

	routines[name] = { manifestPath, ...(manifest.description !== undefined && { description: manifest.description }) };
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);

	return {
		manifestPath,
		createdConfig,
		template,
		...(INPUT_HINTS[template] !== undefined && { inputHint: INPUT_HINTS[template] }),
	};
}
