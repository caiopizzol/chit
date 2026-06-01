import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_MARKER_FILENAME, type InstallMarker } from "@chit-run/core";
import { LifecycleError, listInstalled, uninstall } from "./lifecycle.ts";

const VALID_MARKER: InstallMarker = {
	schema: 1,
	surface: "claude-skill",
	installName: "test-skill",
	manifestId: "test",
	runtimePath: "/abs/path/chit",
	installedAt: "2026-05-27T15:41:32.000Z",
	manifestHash: "abc123",
};

let TMPDIR: string;

beforeEach(() => {
	TMPDIR = mkdtempSync(join(tmpdir(), "chit-lifecycle-"));
});

afterEach(() => {
	rmSync(TMPDIR, { recursive: true, force: true });
});

function makeMarkedInstall(name: string, overrides: Partial<InstallMarker> = {}): string {
	const dir = join(TMPDIR, name);
	mkdirSync(dir, { recursive: true });
	const marker: InstallMarker = { ...VALID_MARKER, installName: name, ...overrides };
	writeFileSync(join(dir, INSTALL_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`);
	writeFileSync(join(dir, "SKILL.md"), "(stub)\n");
	writeFileSync(join(dir, "manifest.json"), "{}\n");
	return dir;
}

describe("listInstalled", () => {
	test("returns empty array when parent dir doesn't exist", () => {
		expect(listInstalled(join(TMPDIR, "nope"))).toEqual([]);
	});

	test("finds marked installs and sorts by installName", () => {
		makeMarkedInstall("zeta");
		makeMarkedInstall("alpha");
		makeMarkedInstall("middle");
		const out = listInstalled(TMPDIR);
		expect(out.map((r) => r.marker.installName)).toEqual(["alpha", "middle", "zeta"]);
	});

	test("ignores directories without the install marker (e.g., a foreign tool's skill folder)", () => {
		makeMarkedInstall("chit-consult");
		// A foreign skill with SKILL.md + scripts/ but NO marker
		const foreign = join(TMPDIR, "consult");
		mkdirSync(join(foreign, "scripts"), { recursive: true });
		writeFileSync(join(foreign, "SKILL.md"), "(other tool's skill)\n");
		writeFileSync(join(foreign, "scripts", "consult.js"), "// other\n");
		const out = listInstalled(TMPDIR);
		expect(out.map((r) => r.marker.installName)).toEqual(["chit-consult"]);
	});

	test("ignores directories with malformed marker", () => {
		const dir = join(TMPDIR, "broken");
		mkdirSync(dir);
		writeFileSync(join(dir, INSTALL_MARKER_FILENAME), "{ not valid json");
		makeMarkedInstall("good");
		const out = listInstalled(TMPDIR);
		expect(out.map((r) => r.marker.installName)).toEqual(["good"]);
	});

	test("ignores directories with wrong-shape marker", () => {
		const dir = join(TMPDIR, "shape-wrong");
		mkdirSync(dir);
		writeFileSync(join(dir, INSTALL_MARKER_FILENAME), JSON.stringify({ schema: 99 }));
		makeMarkedInstall("good");
		const out = listInstalled(TMPDIR);
		expect(out.map((r) => r.marker.installName)).toEqual(["good"]);
	});

	test("ignores non-directory entries at the parent path", () => {
		writeFileSync(join(TMPDIR, "stray.txt"), "not a dir\n");
		makeMarkedInstall("good");
		const out = listInstalled(TMPDIR);
		expect(out.length).toBe(1);
	});
});

describe("uninstall", () => {
	test("removes the directory when marker is present and valid", () => {
		const dir = makeMarkedInstall("removable");
		expect(existsSync(dir)).toBe(true);
		const removed = uninstall(TMPDIR, "removable");
		expect(existsSync(dir)).toBe(false);
		expect(removed.marker.installName).toBe("removable");
		expect(removed.skillDir).toBe(dir);
	});

	test("refuses when target directory does not exist", () => {
		expect(() => uninstall(TMPDIR, "ghost")).toThrow(/no install at/);
	});

	test("refuses when directory exists but has no marker", () => {
		const dir = join(TMPDIR, "no-marker");
		mkdirSync(dir);
		writeFileSync(join(dir, "SKILL.md"), "(stub)\n");
		expect(() => uninstall(TMPDIR, "no-marker")).toThrow(
			/no install marker \(\.chit-install\.json\)/,
		);
		// Directory must still exist after a refused uninstall.
		expect(existsSync(dir)).toBe(true);
	});

	test("refuses when marker is malformed JSON", () => {
		const dir = join(TMPDIR, "bad-json");
		mkdirSync(dir);
		writeFileSync(join(dir, INSTALL_MARKER_FILENAME), "{ not json");
		writeFileSync(join(dir, "SKILL.md"), "(stub)\n");
		expect(() => uninstall(TMPDIR, "bad-json")).toThrow(/not valid JSON/);
		expect(existsSync(dir)).toBe(true);
	});

	test("refuses when marker has wrong shape", () => {
		const dir = join(TMPDIR, "wrong-shape");
		mkdirSync(dir);
		writeFileSync(
			join(dir, INSTALL_MARKER_FILENAME),
			JSON.stringify({ schema: 1, surface: "claude-skill" }),
		);
		writeFileSync(join(dir, "SKILL.md"), "(stub)\n");
		expect(() => uninstall(TMPDIR, "wrong-shape")).toThrow(LifecycleError);
		expect(existsSync(dir)).toBe(true);
	});

	test("refuses when target path exists but is not a directory", () => {
		writeFileSync(join(TMPDIR, "file-not-dir"), "regular file\n");
		expect(() => uninstall(TMPDIR, "file-not-dir")).toThrow(/not a directory/);
	});

	test("rejects path-traversal name even when a valid marker exists at the traversed path", () => {
		// Set up an "intended" parent dir and a sibling "sensitive" location
		// that also has a valid chit marker (as if the user has two --to
		// locations, both legitimately chit-managed). Without the
		// kebab-case guard, `uninstall(intended, "../sensitive-parent")` would
		// rm the sensitive sibling: join() resolves outside intended, and the
		// marker check passes because we put a valid marker there.
		const intended = join(TMPDIR, "intended-parent");
		const sensitive = join(TMPDIR, "sensitive-parent");
		mkdirSync(intended, { recursive: true });
		mkdirSync(sensitive, { recursive: true });
		const marker = { ...VALID_MARKER, installName: "sensitive-parent" };
		writeFileSync(join(sensitive, INSTALL_MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`);
		writeFileSync(join(sensitive, "important.txt"), "do not delete\n");

		expect(() => uninstall(intended, "../sensitive-parent")).toThrow(/install name.*invalid/);
		// Most important: the sensitive sibling directory must still exist.
		expect(existsSync(sensitive)).toBe(true);
		expect(existsSync(join(sensitive, "important.txt"))).toBe(true);
	});

	test("rejects names with slashes", () => {
		expect(() => uninstall(TMPDIR, "foo/bar")).toThrow(/install name.*invalid/);
	});

	test("rejects uppercase / dotted names", () => {
		expect(() => uninstall(TMPDIR, "Foo.Bar")).toThrow(/install name.*invalid/);
	});

	test("rejects empty name", () => {
		expect(() => uninstall(TMPDIR, "")).toThrow(/install name.*invalid/);
	});
});
