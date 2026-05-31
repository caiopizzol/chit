// Browser-safe install-marker definition. A `.chit-install.json` file
// written into each installed skill directory records that the directory
// was created by chit and carries the metadata `chit list` / `chit uninstall`
// need to operate on it safely. (The legacy `.handoff-install.json` name is
// still recognized on read for one release; see lifecycle.ts.)
//
// Why a marker: without one, `chit uninstall <name>` would have to
// infer "is this a chit skill?" by sniffing files like SKILL.md or
// manifest.json — both of which an unrelated skill could legitimately
// have. The marker is a deliberate "yes, chit put this here" signal
// that prevents accidental rm -rf of someone else's directory.

export interface InstallMarker {
	schema: 1;
	// Surface that wrote this install (today: "claude-skill"; future: "mcp", etc.).
	surface: string;
	// Folder name and SKILL.md frontmatter `name:` value. May differ from
	// manifestId when --name override was used at install time.
	installName: string;
	// The manifest's own id, from the source manifest.json.
	manifestId: string;
	// Absolute path to the chit project root baked into SKILL.md.
	runtimePath: string;
	// ISO-8601 timestamp of when this install happened.
	installedAt: string;
	// SHA-256 hex of the manifest.json contents at install time. Lets
	// future tooling detect "manifest was hand-edited after install"
	// without re-parsing the manifest. Not load-bearing for v0 uninstall.
	manifestHash: string;
}

export class MarkerError extends Error {
	constructor(
		public readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`);
		this.name = "MarkerError";
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseInstallMarker(raw: unknown, path: string): InstallMarker {
	if (!isObject(raw)) {
		throw new MarkerError(path, "install marker must be a JSON object");
	}
	if (raw.schema !== 1) {
		throw new MarkerError(path, `unsupported marker schema: ${String(raw.schema)}`);
	}
	const requiredStrings = [
		"surface",
		"installName",
		"manifestId",
		"runtimePath",
		"installedAt",
		"manifestHash",
	] as const;
	for (const k of requiredStrings) {
		const v = raw[k];
		if (typeof v !== "string" || !v) {
			throw new MarkerError(path, `field "${k}" must be a non-empty string`);
		}
	}
	return {
		schema: 1,
		surface: raw.surface as string,
		installName: raw.installName as string,
		manifestId: raw.manifestId as string,
		runtimePath: raw.runtimePath as string,
		installedAt: raw.installedAt as string,
		manifestHash: raw.manifestHash as string,
	};
}

// New marker filename, written by every install. The legacy name is still
// RECOGNIZED on read (list/uninstall) for one release so skills installed before
// the chit rename are not orphaned; nothing writes the legacy name anymore.
export const INSTALL_MARKER_FILENAME = ".chit-install.json";
export const LEGACY_INSTALL_MARKER_FILENAME = ".handoff-install.json";
// Marker names accepted when discovering an installed skill, new first.
export const INSTALL_MARKER_FILENAMES: readonly string[] = [
	INSTALL_MARKER_FILENAME,
	LEGACY_INSTALL_MARKER_FILENAME,
];

// Single source of truth for what a valid install name looks like across the
// platform: a kebab-case slug that is also a safe filesystem segment. Used by
// installClaudeSkill to validate --name overrides at install time, and by
// lifecycle.uninstall to refuse traversal sequences ("../foo", "a/b") that
// would let `<parentDir>/<name>` resolve outside parentDir. Keeping the rule
// in one place prevents install and uninstall from drifting and ensures a
// name that was rejectable at install can never be uninstalled either.
export const VALID_INSTALL_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function isValidInstallName(name: string): boolean {
	return VALID_INSTALL_NAME_RE.test(name);
}
