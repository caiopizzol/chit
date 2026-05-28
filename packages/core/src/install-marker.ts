// Browser-safe install-marker definition. A `.handoff-install.json` file
// written into each installed skill directory records that the directory
// was created by handoff and carries the metadata `handoff list` /
// `handoff uninstall` need to operate on it safely.
//
// Why a marker: without one, `handoff uninstall <name>` would have to
// infer "is this a handoff skill?" by sniffing files like SKILL.md or
// manifest.json — both of which an unrelated skill could legitimately
// have. The marker is a deliberate "yes, handoff put this here" signal
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
	// Absolute path to the handoff project root baked into SKILL.md.
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

export const INSTALL_MARKER_FILENAME = ".handoff-install.json";

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
