// Convention guard: every src/client/**/*.tsx file must declare the React
// JSX runtime via /** @jsxImportSource react */. The workspace tsconfig
// still defaults to Hono JSX for the old SSR inspector. The pragmas are
// the bridge until sub-unit 1.4 deletes the old inspector and the
// workspace default flips. Without this test, a new client .tsx file
// could silently inherit the wrong runtime.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = import.meta.dir;
const PRAGMA = "@jsxImportSource react";

function walkTsx(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const abs = join(dir, name);
		const st = statSync(abs);
		if (st.isDirectory()) {
			walkTsx(abs, acc);
		} else if (st.isFile() && abs.endsWith(".tsx")) {
			acc.push(abs);
		}
	}
	return acc;
}

describe("client JSX runtime pragma", () => {
	test("every .tsx file under src/client/ declares @jsxImportSource react", () => {
		const files = walkTsx(CLIENT_DIR);
		expect(files.length).toBeGreaterThan(0);
		const missing: string[] = [];
		for (const file of files) {
			const head = readFileSync(file, "utf-8").slice(0, 400);
			if (!head.includes(PRAGMA)) missing.push(file);
		}
		expect(missing).toEqual([]);
	});
});
