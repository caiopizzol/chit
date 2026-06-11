import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, resolveManifest } from "@chit-run/core";
import { loadConfig } from "../config/load.ts";
import { validateOneShotAuth } from "../runs/run-once.ts";
import { DEFAULT_PLAN_AUTHOR_MANIFEST } from "./default-plan-author-manifest.ts";

// The embedded planner is shipped in the binary; examples/plan-author.json is the
// canonical example users read and copy. They must stay identical, and the embedded
// one must parse as a valid one-shot manifest, or chit_orchestrate would diverge from
// the example or fail to load from the packaged binary (which ships no examples/).
const EXAMPLE = join(import.meta.dir, "..", "..", "..", "..", "examples", "plan-author.json");

describe("DEFAULT_PLAN_AUTHOR_MANIFEST", () => {
	test("is identical to examples/plan-author.json", () => {
		const fromFile = JSON.parse(readFileSync(EXAMPLE, "utf-8"));
		expect(DEFAULT_PLAN_AUTHOR_MANIFEST).toEqual(fromFile);
	});

	test("parses and resolves as a one-shot manifest the orchestrator can run", () => {
		const manifest = resolveManifest(parseManifest(DEFAULT_PLAN_AUTHOR_MANIFEST), { roles: {} });
		expect(manifest.id).toBe("plan-author");
		expect(manifest.policy.kind).toBe("one-shot");
	});

	// Exercise EXACTLY what chit_orchestrate's production runPlanner does up to (but not
	// including) the model call: resolve the embedded manifest against the real default
	// registry and pass governance with a scope. This proves the bundled planner loads and
	// validates from the embedded constant -- the packaging path the disk read used to break --
	// without invoking a real model.
	test("loads and passes one-shot governance against the default registry (no model)", () => {
		const config = loadConfig(undefined, { cwd: process.cwd() });
		const manifest = resolveManifest(parseManifest(DEFAULT_PLAN_AUTHOR_MANIFEST), {
			roles: config.roles,
		});
		const auth = validateOneShotAuth(manifest, config.registry, {
			scope: "orchestrate-test",
			allowUnenforced: false,
		});
		expect(auth.ok).toBe(true);
	});
});
