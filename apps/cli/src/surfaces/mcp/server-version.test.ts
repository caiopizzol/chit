import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeServerVersion, resolveOwnVersion } from "./server-version.ts";

describe("describeServerVersion", () => {
	test("same versions report only the running version, no skew fields", () => {
		expect(describeServerVersion("1.2.3", "1.2.3")).toEqual({ version: "1.2.3" });
	});

	test("differing versions add installedVersion and a note naming both", () => {
		const info = describeServerVersion("1.2.3", "1.3.0");
		expect(info.version).toBe("1.2.3");
		expect(info.installedVersion).toBe("1.3.0");
		expect(info.note).toContain("1.2.3");
		expect(info.note).toContain("1.3.0");
	});

	test("an unknown running version never claims skew, even when installed is known", () => {
		const info = describeServerVersion(undefined, "1.3.0");
		expect(info).toEqual({ version: "unknown" });
	});

	test("an unknown installed version reports only the running version", () => {
		expect(describeServerVersion("1.2.3", undefined)).toEqual({ version: "1.2.3" });
	});
});

describe("resolveOwnVersion", () => {
	// Every temp tree is registered here and removed after each test, matching the
	// repo's no-leaked-tmpdirs convention (see worktree.test.ts / run-workspace.test.ts).
	let roots: string[] = [];
	afterEach(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
		roots = [];
	});
	function tempRoot(prefix: string): string {
		const root = mkdtempSync(join(tmpdir(), prefix));
		roots.push(root);
		return root;
	}

	// Build a temp tree:  root/  (matching @chit-run/cli package.json)
	//                     root/nested/  (decoy package.json, different name)
	//                     root/nested/deep/  (start here, walk up)
	// The decoy sits CLOSER to the start than the match, so the resolver must walk
	// PAST the decoy (name mismatch) and keep going to find the matching package.
	// This guards the "name check, not depth" contract.
	function makeTree(): { start: string } {
		const root = tempRoot("chit-ownver-");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@chit-run/cli", version: "4.5.6" }),
		);
		const nested = join(root, "nested");
		mkdirSync(nested);
		writeFileSync(
			join(nested, "package.json"),
			JSON.stringify({ name: "@chit-run/decoy", version: "9.9.9" }),
		);
		const deep = join(nested, "deep");
		mkdirSync(deep);
		return { start: deep };
	}

	test("the matching @chit-run/cli package.json wins over a closer decoy", () => {
		const { start } = makeTree();
		expect(resolveOwnVersion(start)).toBe("4.5.6");
	});

	test("no matching package.json within the walk returns undefined", () => {
		const root = tempRoot("chit-ownver-none-");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@chit-run/decoy", version: "9.9.9" }),
		);
		expect(resolveOwnVersion(root)).toBeUndefined();
	});

	test("an unparseable package.json does not throw and returns undefined", () => {
		const root = tempRoot("chit-ownver-bad-");
		writeFileSync(join(root, "package.json"), "{ not valid json");
		expect(resolveOwnVersion(root)).toBeUndefined();
	});
});
