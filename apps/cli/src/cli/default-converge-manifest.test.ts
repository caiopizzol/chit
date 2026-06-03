import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, resolveManifest } from "@chit-run/core";
import { validateConvergeManifest } from "./converge.ts";
import { DEFAULT_CONVERGE_MANIFEST } from "./default-converge-manifest.ts";

// The embedded default is shipped in the binary; examples/converge.json is the
// canonical example users read and copy. They must stay identical, and the
// embedded one must be a valid converge-shaped manifest, or `chit converge` /
// chit_converge_start with no manifest would diverge from the example or fail.
const EXAMPLE = join(import.meta.dir, "..", "..", "..", "..", "examples", "converge.json");

describe("DEFAULT_CONVERGE_MANIFEST", () => {
	test("is byte-identical to examples/converge.json", () => {
		const fromFile = JSON.parse(readFileSync(EXAMPLE, "utf-8"));
		expect(DEFAULT_CONVERGE_MANIFEST).toEqual(fromFile);
	});

	test("parses and satisfies the converge contract (implement + review steps)", () => {
		const manifest = resolveManifest(parseManifest(DEFAULT_CONVERGE_MANIFEST), { roles: {} });
		expect(manifest.id).toBe("converge");
		expect(validateConvergeManifest(manifest)).toBeNull();
	});
});
