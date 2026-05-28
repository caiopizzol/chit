// Boot-time explicit path resolution. Unlike the old apps/studio path
// resolver, this one does NOT enforce a workspace boundary: the user is
// the authority when they pass an explicit path.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PathError, resolveExplicitPath } from "./paths.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "chit-studio-paths-"));
}

describe("resolveExplicitPath", () => {
	test("resolves a relative path against cwd", () => {
		const cwd = tempCwd();
		try {
			writeFileSync(join(cwd, "a.json"), "{}");
			const resolved = resolveExplicitPath("a.json", cwd);
			expect(isAbsolute(resolved)).toBe(true);
			expect(resolved.endsWith("a.json")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("accepts an absolute path inside cwd", () => {
		const cwd = tempCwd();
		try {
			const abs = join(cwd, "a.json");
			writeFileSync(abs, "{}");
			expect(resolveExplicitPath(abs, cwd)).toBe(abs);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("accepts an absolute path outside cwd", () => {
		// The user is the authority when they pass an explicit path.
		const cwdA = tempCwd();
		const cwdB = tempCwd();
		try {
			const abs = join(cwdB, "elsewhere.json");
			writeFileSync(abs, "{}");
			expect(resolveExplicitPath(abs, cwdA)).toBe(abs);
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
		}
	});

	test("accepts a relative path escaping cwd (../)", () => {
		// chit studio ../foo.json is intentional. The discovery scan stays
		// cwd-only; the explicit-path branch trusts the user.
		const parent = tempCwd();
		const cwd = join(parent, "child");
		mkdirSync(cwd);
		writeFileSync(join(parent, "sibling.json"), "{}");
		try {
			const resolved = resolveExplicitPath("../sibling.json", cwd);
			expect(resolved).toBe(join(parent, "sibling.json"));
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("throws not-found for a missing path", () => {
		const cwd = tempCwd();
		try {
			expect(() => resolveExplicitPath("nope.json", cwd)).toThrow(PathError);
			try {
				resolveExplicitPath("nope.json", cwd);
			} catch (e) {
				expect(e).toBeInstanceOf(PathError);
				expect((e as PathError).reason).toBe("not-found");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("throws not-file for a directory", () => {
		const cwd = tempCwd();
		try {
			mkdirSync(join(cwd, "dir.json"));
			try {
				resolveExplicitPath("dir.json", cwd);
				throw new Error("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(PathError);
				expect((e as PathError).reason).toBe("not-file");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
