import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopLogDir, loopStateDir, repoKey, repoRoot } from "./location.ts";

let savedXdg: string | undefined;
let tmp: string;

beforeEach(() => {
	savedXdg = process.env.XDG_STATE_HOME;
	tmp = mkdtempSync(join(tmpdir(), "chit-loc-"));
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string) {
	spawnSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
}

describe("loop-log location: repoRoot / repoKey", () => {
	test("a non-git dir keys by its canonical (realpath) path, stably", () => {
		expect(repoRoot(tmp)).toBe(realpathSync(tmp));
		expect(repoKey(tmp)).toBe(repoKey(tmp));
		expect(repoKey(tmp)).toMatch(/^[0-9a-f]{16}$/);
	});

	test("a subdir of a git repo keys to the repo top-level", () => {
		gitInit(tmp);
		const sub = join(tmp, "packages", "deep");
		mkdirSync(sub, { recursive: true });
		// repoRoot of any subdir resolves to the (realpath'd) top-level.
		expect(repoRoot(sub)).toBe(realpathSync(tmp));
		expect(repoKey(sub)).toBe(repoKey(tmp));
	});

	test("two distinct repos get distinct keys", () => {
		const other = mkdtempSync(join(tmpdir(), "chit-loc-"));
		try {
			expect(repoKey(tmp)).not.toBe(repoKey(other));
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("loop-log location: paths", () => {
	test("loopStateDir honors XDG_STATE_HOME", () => {
		process.env.XDG_STATE_HOME = join(tmp, "xdg");
		expect(loopStateDir()).toBe(join(tmp, "xdg", "chit", "loops"));
	});

	test("loopLogDir nests the repo key under the state dir", () => {
		process.env.XDG_STATE_HOME = tmp;
		expect(loopLogDir(tmp)).toBe(join(tmp, "chit", "loops", repoKey(tmp)));
	});
});
