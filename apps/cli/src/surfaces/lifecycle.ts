import { existsSync, readdirSync, readFileSync, rmSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	INSTALL_MARKER_FILENAME,
	INSTALL_MARKER_FILENAMES,
	type InstallMarker,
	MarkerError,
	parseInstallMarker,
	VALID_INSTALL_NAME_RE,
} from "@chit/core";

// Resolve a skill directory's install marker, preferring the current name and
// falling back to the legacy one, so a skill installed before the chit rename is
// still listable and uninstallable. Returns undefined when neither is present.
function resolveMarkerPath(skillDir: string): string | undefined {
	for (const name of INSTALL_MARKER_FILENAMES) {
		const p = join(skillDir, name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

// Where the CLI looks by default. Mirrors `chit install --to`'s default.
export function defaultSkillsDir(): string {
	return join(homedir(), ".claude", "skills");
}

export interface InstalledRecord {
	skillDir: string;
	markerPath: string;
	marker: InstallMarker;
}

export class LifecycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LifecycleError";
	}
}

// Walk the parent directory looking for an install marker under `<dir>/<name>/`
// (`.chit-install.json`, or the legacy `.handoff-install.json`).
// Directories without a marker are silently skipped (they belong to someone
// else - e.g., a foreign tool's same-named skill folder). Markers that are
// malformed JSON or shape-mismatched are also silently skipped so `chit list`
// keeps working when a foreign tool happens to write a same-named file.
// Surfacing those as error records (so `chit list` can flag them) is a
// future enhancement; today the safe-default is silence.
export function listInstalled(parentDir: string): InstalledRecord[] {
	if (!existsSync(parentDir)) return [];
	const out: InstalledRecord[] = [];
	const entries = readdirSync(parentDir);
	for (const name of entries) {
		const skillDir = join(parentDir, name);
		let stat: Stats;
		try {
			stat = statSync(skillDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const markerPath = resolveMarkerPath(skillDir);
		if (markerPath === undefined) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(markerPath, "utf-8"));
		} catch {
			// Malformed JSON. Skip silently in v0; future: include in result
			// as an `errors` array so `chit list` can flag it.
			continue;
		}
		try {
			const marker = parseInstallMarker(raw, markerPath);
			out.push({ skillDir, markerPath, marker });
		} catch {
			// Shape mismatch (foreign tool wrote a same-named file). Skip.
		}
	}
	return out.sort((a, b) => a.marker.installName.localeCompare(b.marker.installName));
}

// Remove the install at <parentDir>/<name>. Refuses unless the directory
// contains a valid install marker (`.chit-install.json`, or the legacy
// `.handoff-install.json`). This is the safety boundary:
// without a marker, we don't know we put the directory there, and we don't
// rm someone else's data.
//
// The `name` is validated against the platform-wide kebab-case rule BEFORE
// any path join, mirroring install. Without this check, a name like
// "../sibling" would let `join(parentDir, name)` resolve to a directory
// outside parentDir; if that location happened to contain a valid chit
// marker (e.g., a legitimate install in another `--to` location), uninstall
// would rm-rf it. The marker check alone is not sufficient: an attacker (or
// a fat-fingered user with two `--to` locations) can satisfy both gates.
export function uninstall(parentDir: string, name: string): InstalledRecord {
	if (!VALID_INSTALL_NAME_RE.test(name)) {
		throw new LifecycleError(
			`install name "${name}" is invalid: must be kebab-case (lowercase letters, digits, hyphens; must start with a letter). Path-traversal sequences like ".." or "/" are rejected.`,
		);
	}
	const skillDir = join(parentDir, name);
	if (!existsSync(skillDir)) {
		throw new LifecycleError(`no install at ${skillDir}`);
	}
	if (!statSync(skillDir).isDirectory()) {
		throw new LifecycleError(`${skillDir} is not a directory`);
	}
	const markerPath = resolveMarkerPath(skillDir);
	if (markerPath === undefined) {
		throw new LifecycleError(
			`refusing to uninstall ${skillDir}: no install marker (${INSTALL_MARKER_FILENAMES.join(" or ")}) present. ` +
				`This directory was not created by chit (or was created by a pre-marker version). ` +
				`If you're sure this is yours, remove it manually with rm -rf.`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(markerPath, "utf-8"));
	} catch (e) {
		throw new LifecycleError(
			`refusing to uninstall ${skillDir}: ${INSTALL_MARKER_FILENAME} is not valid JSON (${(e as Error).message})`,
		);
	}
	let marker: InstallMarker;
	try {
		marker = parseInstallMarker(raw, markerPath);
	} catch (e) {
		if (e instanceof MarkerError) {
			throw new LifecycleError(`refusing to uninstall ${skillDir}: ${e.message}`);
		}
		throw e;
	}

	const record: InstalledRecord = { skillDir, markerPath, marker };
	rmSync(skillDir, { recursive: true, force: true });
	return record;
}
