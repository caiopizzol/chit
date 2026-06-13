// The config layer is deliberately thin: it NAMES routines and points each at a
// manifest, plus optional run defaults. It never restates inputs, participants,
// or steps -- that all lives in the manifest. This split is the product model:
// "routines" is the one concept a user configures.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RoutineConfig {
	manifestPath: string;
	description?: string;
	defaults?: { maxIterations?: number };
}

export interface ChitConfig {
	routines: Record<string, RoutineConfig>;
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
		if (k !== "routines") throw new ConfigError(source, `unknown field "${k}"`);
	}
	if (!isObject(raw.routines)) throw new ConfigError(source, "`routines` must be an object");
	const routines: Record<string, RoutineConfig> = {};
	for (const [id, entry] of Object.entries(raw.routines)) {
		const where = `${source}.routines.${id}`;
		if (!ROUTINE_ID_RE.test(id)) {
			throw new ConfigError(where, "routine id must be kebab-case (start with a letter)");
		}
		if (!isObject(entry)) throw new ConfigError(where, "must be an object");
		for (const k of Object.keys(entry)) {
			if (!["manifestPath", "description", "defaults"].includes(k)) {
				throw new ConfigError(where, `unknown field "${k}"`);
			}
		}
		if (typeof entry.manifestPath !== "string" || !entry.manifestPath) {
			throw new ConfigError(where, "`manifestPath` must be a non-empty string");
		}
		// Minimal path safety: a routine cannot reach outside the config's folder.
		// (The hardened runtime does full repo-relative confinement; here we just
		// refuse the obvious escape so a proof config stays self-contained.)
		if (entry.manifestPath.includes("..")) {
			throw new ConfigError(where, "`manifestPath` must not contain `..`");
		}
		if (entry.description !== undefined && typeof entry.description !== "string") {
			throw new ConfigError(where, "`description` must be a string");
		}
		let defaults: RoutineConfig["defaults"];
		if (entry.defaults !== undefined) {
			if (!isObject(entry.defaults)) throw new ConfigError(where, "`defaults` must be an object");
			for (const k of Object.keys(entry.defaults)) {
				if (k !== "maxIterations") throw new ConfigError(`${where}.defaults`, `unknown field "${k}"`);
			}
			const mi = entry.defaults.maxIterations;
			if (mi !== undefined && (typeof mi !== "number" || !Number.isInteger(mi) || mi < 1)) {
				throw new ConfigError(`${where}.defaults`, "`maxIterations` must be a positive integer");
			}
			defaults = mi !== undefined ? { maxIterations: mi } : {};
		}
		routines[id] = {
			manifestPath: entry.manifestPath,
			...(typeof entry.description === "string" && { description: entry.description }),
			...(defaults !== undefined && { defaults }),
		};
	}
	return { routines };
}
