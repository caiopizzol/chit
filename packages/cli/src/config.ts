// The config layer is deliberately thin: it names routines and binds model
// profiles. A routine can be inline for first-run DX, or point at a separate
// file once it grows. Both normalize to the same Manifest shape before runtime.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ADAPTER_IDS, CLAUDE_EFFORTS, CODEX_REASONING_EFFORTS, isBuiltInAdapter, isStructurallyValidModel } from "./builtin-adapters.ts";
import { type Manifest, parseManifest } from "./manifest.ts";

export interface RoutineConfig {
	manifestPath: string;
	manifest?: Manifest;
	manifestText?: string;
	description?: string;
	defaults?: { maxIterations?: number };
}

// A local binding: which actual adapter (and model) backs a participant. Manifests
// reference an agent by id (`participant.agent`); the config says what that id IS.
// This is the split: manifest = workflow; config = local agent/model bindings.
export interface AgentConfig {
	adapter: string;
	model?: string;
	// Adapter-specific execution depth. Kept on the profile because it is part of
	// the local model binding, not the reusable routine.
	effort?: "low" | "medium" | "high" | "max";
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ChitConfig {
	routines: Record<string, RoutineConfig>;
	// Internal normalized name. The authoring file may use `profiles` (preferred)
	// or the older `agents` alias.
	agents: Record<string, AgentConfig>;
}

export class ConfigError extends Error {
	constructor(
		readonly source: string,
		readonly detail: string,
	) {
		super(`${source}: ${detail}`);
		this.name = "ConfigError";
	}
}

// Read and parse chit.config.json from a directory. Kept next to parseConfig so
// the file boundary is one hop from the validation.
export function loadConfig(cwd: string): ChitConfig {
	const path = join(cwd, "chit.config.json");
	if (!existsSync(path)) {
		throw new ConfigError("chit.config.json", `no config found in ${cwd}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new ConfigError("chit.config.json", `invalid JSON: ${(e as Error).message}`);
	}
	return parseConfig(raw, "chit.config.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

const ROUTINE_ID_RE = /^[a-z][a-z0-9-]*$/;

export function parseConfig(raw: unknown, source: string): ChitConfig {
	if (!isObject(raw)) throw new ConfigError(source, "config must be an object");
	for (const k of Object.keys(raw)) {
		if (k !== "$schema" && k !== "routines" && k !== "agents" && k !== "profiles") throw new ConfigError(source, `unknown field "${k}"`);
	}
	if (!isObject(raw.routines)) throw new ConfigError(source, "`routines` must be an object");
	const routines: Record<string, RoutineConfig> = {};
	for (const [id, entry] of Object.entries(raw.routines)) {
		const where = `${source}.routines.${id}`;
		if (!ROUTINE_ID_RE.test(id)) {
			throw new ConfigError(where, "routine id must be kebab-case (start with a letter)");
		}
		routines[id] = parseRoutineConfigEntry(id, entry, where);
	}

	const agents: Record<string, AgentConfig> = {};
	if (raw.agents !== undefined && raw.profiles !== undefined) {
		throw new ConfigError(source, "`profiles` and `agents` are aliases; use one of them");
	}
	const rawProfiles = raw.profiles ?? raw.agents;
	if (rawProfiles !== undefined) {
		const profileField = raw.profiles !== undefined ? "profiles" : "agents";
		if (!isObject(rawProfiles)) throw new ConfigError(source, `\`${profileField}\` must be an object`);
		for (const [id, entry] of Object.entries(rawProfiles)) {
			const where = `${source}.${profileField}.${id}`;
			agents[id] = parseAgentConfig(entry, where);
		}
	}

	return { routines, agents };
}

function parseRoutineConfigEntry(id: string, entry: unknown, where: string): RoutineConfig {
	if (typeof entry === "string") {
		return fileRoutine(entry, where);
	}
	if (!isObject(entry)) throw new ConfigError(where, "must be an object or a file path string");

	const hasFile = entry.file !== undefined || entry.manifestPath !== undefined;
	if (hasFile) {
		for (const k of Object.keys(entry)) {
			if (!["file", "manifestPath", "description", "defaults"].includes(k)) {
				throw new ConfigError(where, `unknown field "${k}"`);
			}
		}
		if (entry.file !== undefined && entry.manifestPath !== undefined) {
			throw new ConfigError(where, "`file` and `manifestPath` are aliases; use one of them");
		}
		const file = entry.file ?? entry.manifestPath;
		const routine = fileRoutine(file, where);
		const defaults = parseDefaults(entry.defaults, where);
		return {
			...routine,
			...(typeof entry.description === "string" && { description: entry.description }),
			...(defaults !== undefined && { defaults }),
		};
	}

	const defaults = parseDefaults(entry.defaults, where);
	const manifestRaw = { ...entry, id };
	delete (manifestRaw as Record<string, unknown>).defaults;
	let manifest: Manifest;
	try {
		manifest = parseManifest(manifestRaw, where);
	} catch (e) {
		throw new ConfigError(where, (e as Error).message);
	}
	const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
	return {
		manifestPath: `chit.config.json#routines.${id}`,
		manifest,
		manifestText,
		...(manifest.description !== undefined && { description: manifest.description }),
		...(defaults !== undefined && { defaults }),
	};
}

function fileRoutine(file: unknown, where: string): RoutineConfig {
	if (typeof file !== "string" || !file) {
		throw new ConfigError(where, "`file` must be a non-empty string");
	}
	if (file.includes("..")) {
		throw new ConfigError(where, "`file` must not contain `..`");
	}
	return { manifestPath: file };
}

function parseDefaults(raw: unknown, where: string): RoutineConfig["defaults"] {
	if (raw === undefined) return undefined;
	if (!isObject(raw)) throw new ConfigError(where, "`defaults` must be an object");
	for (const k of Object.keys(raw)) {
		if (k !== "maxIterations") throw new ConfigError(`${where}.defaults`, `unknown field "${k}"`);
	}
	const mi = raw.maxIterations;
	if (mi !== undefined && (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1)) {
		throw new ConfigError(`${where}.defaults`, "`maxIterations` must be a positive integer");
	}
	return mi !== undefined ? { maxIterations: mi } : {};
}

// A built-in adapter's model must structurally belong to it (codex:sonnet is rejected here,
// before a run, not deep in execution). "default"/omitted always pass, and a custom adapter's
// model is opaque. This is structural only -- account access is `chit doctor`'s job.
function validateBuiltInModel(adapter: string, model: string | undefined, where: string): void {
	if (model === undefined || model === "default" || !isBuiltInAdapter(adapter)) return;
	if (!isStructurallyValidModel(adapter, model)) {
		throw new ConfigError(where, `model "${model}" is not valid for adapter "${adapter}"`);
	}
}

function parseProfileEffort(raw: unknown, where: string): AgentConfig["effort"] {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || !(CLAUDE_EFFORTS as readonly string[]).includes(raw)) {
		throw new ConfigError(`${where}.effort`, 'must be one of "low", "medium", "high", "max"');
	}
	return raw as AgentConfig["effort"];
}

function parseProfileReasoningEffort(raw: unknown, where: string): AgentConfig["reasoningEffort"] {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || !(CODEX_REASONING_EFFORTS as readonly string[]).includes(raw)) {
		throw new ConfigError(`${where}.reasoningEffort`, 'must be one of "minimal", "low", "medium", "high", "xhigh"');
	}
	return raw as AgentConfig["reasoningEffort"];
}

function validateProfileOptions(adapter: string, effort: AgentConfig["effort"], reasoningEffort: AgentConfig["reasoningEffort"], where: string): void {
	if (effort !== undefined && adapter !== "claude") {
		throw new ConfigError(`${where}.effort`, '`effort` is only supported by the claude adapter');
	}
	if (reasoningEffort !== undefined && adapter !== "codex") {
		throw new ConfigError(`${where}.reasoningEffort`, '`reasoningEffort` is only supported by the codex adapter');
	}
}

function parseAgentConfig(entry: unknown, where: string): AgentConfig {
	if (typeof entry === "string") {
		const [adapter, ...rest] = entry.split(":");
		if (!adapter) throw new ConfigError(where, "profile string must start with an adapter name");
		const model = rest.join(":");
		// Shorthand is reserved for built-in adapters; a custom adapter must use the object form,
		// so the structural model rules are never silently skipped for an unknown adapter.
		if (!isBuiltInAdapter(adapter)) {
			throw new ConfigError(
				where,
				`unknown adapter "${adapter}" (built-in: ${BUILT_IN_ADAPTER_IDS.join(", ")}). A custom adapter must use the object form { "adapter": "${adapter}", "model": "..." }`,
			);
		}
		// A trailing ":" with no model (e.g. "codex:") would silently mean "default", but the schema
		// rejects it -- so reject it here too, keeping the parser and schema in lockstep. Drop the
		// colon ("codex") to get the default model.
		if (rest.length > 0 && model === "") {
			throw new ConfigError(where, `profile "${entry}" has a trailing ":" but no model; use "${adapter}" for the default model`);
		}
		validateBuiltInModel(adapter, model || undefined, where);
		return { adapter, ...(model ? { model } : {}) };
	}
	if (!isObject(entry)) throw new ConfigError(where, "must be an object or adapter string");
	for (const k of Object.keys(entry)) {
		if (k !== "adapter" && k !== "model" && k !== "effort" && k !== "reasoningEffort") throw new ConfigError(where, `unknown field "${k}"`);
	}
	if (typeof entry.adapter !== "string" || !entry.adapter) {
		throw new ConfigError(where, "`adapter` must be a non-empty string");
	}
	if (entry.model !== undefined && typeof entry.model !== "string") {
		throw new ConfigError(where, "`model` must be a string");
	}
	const effort = parseProfileEffort(entry.effort, where);
	const reasoningEffort = parseProfileReasoningEffort(entry.reasoningEffort, where);
	validateBuiltInModel(entry.adapter, typeof entry.model === "string" ? entry.model : undefined, where);
	validateProfileOptions(entry.adapter, effort, reasoningEffort, where);
	return {
		adapter: entry.adapter,
		...(typeof entry.model === "string" && { model: entry.model }),
		...(effort !== undefined && { effort }),
		...(reasoningEffort !== undefined && { reasoningEffort }),
	};
}
