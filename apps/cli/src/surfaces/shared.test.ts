import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AdapterKind,
	collectInvocationWarnings,
	findEnforcementGaps,
	type NormalizedRegistry,
	parseManifest,
	parseRegistry,
} from "@chit/core";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "..", "examples");
const CONSULT = parseManifest(JSON.parse(readFileSync(join(EXAMPLES, "consult.json"), "utf-8")));
const ASK_CODEX = parseManifest(
	JSON.parse(readFileSync(join(EXAMPLES, "ask-codex.json"), "utf-8")),
);
const REGISTRY = parseRegistry(undefined);

// A test-only registry: the claude agent points at an adapter kind with no
// descriptor, so getAdapterDescriptor returns undefined and read_only is
// unenforceable. No built-in adapter is unenforceable anymore (codex sandboxes,
// claude uses plan mode), so we synthesize one to keep the gap -> warning/refusal
// path under test for a future non-enforcing adapter.
const UNENFORCED_REGISTRY: NormalizedRegistry = {
	...REGISTRY,
	agents: {
		...REGISTRY.agents,
		claude: {
			id: "claude",
			adapter: "noop" as AdapterKind,
			passModelOnResume: false,
			builtIn: true,
		},
	},
};

describe("collectInvocationWarnings", () => {
	test("returns empty without the unenforced-permissions opt-in", () => {
		// Without the opt-in, the strict-path refusal upstream prevents the
		// run; warnings here would be moot. Helper returns nothing.
		const warnings = collectInvocationWarnings(CONSULT, REGISTRY, {
			allowUnenforcedPermissions: false,
		});
		expect(warnings).toEqual([]);
	});

	test("returns no warnings for consult: both adapters enforce read_only", () => {
		// consult mixes codex (sandbox) and claude (plan mode); both enforce
		// read_only, so the opt-in produces no permission_unenforced warnings.
		const warnings = collectInvocationWarnings(CONSULT, REGISTRY, {
			allowUnenforcedPermissions: true,
		});
		expect(warnings).toEqual([]);
	});

	test("returns no warnings when adapters enforce all declared permissions", () => {
		// ask-codex uses only codex-exec (sandboxes filesystem); no gaps.
		const warnings = collectInvocationWarnings(ASK_CODEX, REGISTRY, {
			allowUnenforcedPermissions: true,
		});
		expect(warnings).toEqual([]);
	});

	test("returns one permission_unenforced warning per gap (synthetic non-enforcing adapter)", () => {
		// consult's claude participant is read_only; with the synthetic registry its
		// adapter cannot enforce that, so the opt-in surfaces exactly one warning.
		const warnings = collectInvocationWarnings(CONSULT, UNENFORCED_REGISTRY, {
			allowUnenforcedPermissions: true,
		});
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.kind).toBe("permission_unenforced");
		expect(warnings[0]?.participantId).toBe("claude");
		expect(warnings[0]?.agentId).toBe("claude");
		expect(warnings[0]?.message).toContain("filesystem: read_only");
	});
});

describe("findEnforcementGaps", () => {
	test("no gaps when every read_only participant's adapter enforces it", () => {
		// Built-in registry: codex sandboxes, claude uses plan mode.
		expect(findEnforcementGaps(CONSULT, REGISTRY)).toEqual([]);
	});

	test("flags a read_only participant whose adapter cannot enforce it", () => {
		const gaps = findEnforcementGaps(CONSULT, UNENFORCED_REGISTRY);
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.participantId).toBe("claude");
		expect(gaps[0]?.agentId).toBe("claude");
		expect(gaps[0]?.permission).toBe("filesystem: read_only");
	});
});
