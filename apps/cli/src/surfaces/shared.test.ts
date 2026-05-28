import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectInvocationWarnings, parseManifest, parseRegistry } from "@chit/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples");
const CONSULT = parseManifest(JSON.parse(readFileSync(join(EXAMPLES, "consult.json"), "utf-8")));
const ASK_CODEX = parseManifest(
	JSON.parse(readFileSync(join(EXAMPLES, "ask-codex.json"), "utf-8")),
);
const REGISTRY = parseRegistry(undefined);

describe("collectInvocationWarnings", () => {
	test("returns empty without the unenforced-permissions opt-in", () => {
		// Without the opt-in, the strict-path refusal upstream prevents the
		// run; warnings here would be moot. Helper returns nothing.
		const warnings = collectInvocationWarnings(CONSULT, REGISTRY, {
			allowUnenforcedPermissions: false,
		});
		expect(warnings).toEqual([]);
	});

	test("returns one permission_unenforced warning per gap when opted in", () => {
		const warnings = collectInvocationWarnings(CONSULT, REGISTRY, {
			allowUnenforcedPermissions: true,
		});
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.kind).toBe("permission_unenforced");
		expect(warnings[0]?.participantId).toBe("claude");
		expect(warnings[0]?.agentId).toBe("claude");
		expect(warnings[0]?.message).toContain("filesystem: read_only");
		expect(warnings[0]?.message).toContain("cannot enforce");
	});

	test("returns no warnings when adapters enforce all declared permissions", () => {
		// ask-codex uses only codex-exec (sandboxes filesystem); no gaps.
		const warnings = collectInvocationWarnings(ASK_CODEX, REGISTRY, {
			allowUnenforcedPermissions: true,
		});
		expect(warnings).toEqual([]);
	});
});
