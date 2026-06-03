// Role references, end to end. parse.test.ts proves a `{ "role": "reviewer" }`
// participant PARSES; resolve.test.ts proves resolveManifest APPLIES a role. These
// tests prove the role's resolved values actually flow through each execution
// surface, and -- the real regression guard -- that every surface threads the
// config's roles into resolution instead of an empty map.
//
// Surfaces covered with a role-referencing manifest: one-shot execution, the
// converge (loop) chokepoint, the background worker's config-on-disk path, show,
// and audit. Batch is deliberately NOT re-proven here: it performs no resolution of
// its own. A batch task's manifestPath is opaque to the batch engine and forwarded
// to the worker, which resolves it with config.roles. That forwarding is covered in
// batches/engine.test.ts; resolution is covered by the background case below. A
// batch-level role-ref test would only re-exercise the forwarding, not resolution.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildGraphModel,
	type NormalizedRole,
	parseManifest,
	parseRegistry,
	resolveManifest,
	resolveParticipantSnapshots,
} from "@chit-run/core";
import { prepareConvergeExecute } from "./cli/converge.ts";
import { loadConfig } from "./config/load.ts";
import { runManifestOnce } from "./runs/run-once.ts";
import type { AdapterCallRequest, AdapterMap } from "./runtime/types.ts";

// A reviewer role: supplies the agent (codex, a built-in) and a distinctive
// instructions string so we can assert it reaches the agent-facing input.
const REVIEWER: NormalizedRole = {
	agent: "codex",
	instructions: "Review the diff skeptically; approve only when correct.",
	session: "stateless",
	permissions: { filesystem: "read_only" },
};

// A one-shot manifest whose only participant is a bare role reference: it carries
// no inline agent/instructions/session, so every concrete value comes from the
// role at resolution. Used for the one-shot, show, and audit surfaces.
const ONESHOT_ROLEREF = {
	schema: 1,
	id: "role-oneshot",
	description: "one-shot run driven by a role reference",
	inputs: { q: { type: "string" } },
	participants: { reviewer: { role: "reviewer" } },
	steps: {
		ask: { call: "reviewer", prompt: "{{ inputs.q }}" },
		out: { format: "{{ steps.ask.output }}" },
	},
	output: "out",
};

// A loop manifest with a role-referencing reviewer, for the converge chokepoint.
const LOOP_ROLEREF = {
	schema: 1,
	id: "role-loop",
	description: "loop run with a role-referencing reviewer",
	inputs: { task: { type: "string" } },
	participants: {
		implementer: { agent: "claude", instructions: "Implement the task.", session: "stateless" },
		reviewer: { role: "reviewer" },
	},
	steps: {
		implement: { call: "implementer", prompt: "{{ inputs.task }}" },
		review: { call: "reviewer", prompt: "{{ steps.implement.output }}" },
		out: { format: "{{ steps.review.output }}" },
	},
	output: "out",
	policy: { kind: "loop", implementStep: "implement", reviewStep: "review" },
};

// A fake adapter map (keyed by agent id) that records the request it received.
function capturingAdapter(): { adapters: AdapterMap; seen: AdapterCallRequest[] } {
	const seen: AdapterCallRequest[] = [];
	const adapters = {
		codex: {
			call: async (req: AdapterCallRequest) => {
				seen.push(req);
				return { output: "ok" };
			},
		},
	} as unknown as AdapterMap;
	return { adapters, seen };
}

describe("role references, end to end", () => {
	test("one-shot: the role supplies the agent and instructions that reach the adapter", async () => {
		const manifest = resolveManifest(parseManifest(ONESHOT_ROLEREF), {
			roles: { reviewer: REVIEWER },
		});
		const { adapters, seen } = capturingAdapter();
		const r = await runManifestOnce(manifest, {
			inputs: { q: "is it correct?" },
			registry: parseRegistry(undefined),
			invocationCwd: "/tmp",
			surface: "mcp",
			adapters,
		});
		expect(r.ok).toBe(true);
		// The participant declared no inline agent: codex came from the role, and the
		// call was dispatched to the codex adapter.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.agentId).toBe("codex");
		// buildAgentInput embeds the participant's instructions (here, the role's) in
		// the agent-facing input, so the role's persona actually drove the call.
		expect(seen[0]?.input).toContain("Review the diff skeptically");
	});

	test("loop: prepareConvergeExecute threads the roles into resolution (not an empty map)", () => {
		const registry = parseRegistry(undefined);
		const withRole = prepareConvergeExecute(LOOP_ROLEREF, registry, "scope-x", "/tmp", false, {
			reviewer: REVIEWER,
		});
		expect(withRole.ok).toBe(true);
		// The same manifest with an empty roles map cannot resolve the reviewer
		// reference. The error proves the `roles` argument actually reaches
		// resolveManifest at this chokepoint (the CLI, worker, and MCP launchers all
		// flow through it), rather than being dropped to {}.
		const withoutRole = prepareConvergeExecute(
			LOOP_ROLEREF,
			registry,
			"scope-x",
			"/tmp",
			false,
			{},
		);
		expect(withoutRole.ok).toBe(false);
		if (!withoutRole.ok) expect(withoutRole.error).toContain('unknown role "reviewer"');
	});

	// Background worker. The worker resolves with loadConfig().roles (defaultRunOnce
	// for one-shot jobs, defaultResolveExecute -> prepareConvergeExecute for loop
	// jobs). This drives that exact composition from a real config.json on disk:
	// loadConfig() -> roles -> resolveManifest -> runManifestOnce (the worker's
	// one-shot executor). It is also the path a batch task takes: the batch engine
	// forwards a task's manifestPath to this worker (see the file header).
	test("background: a role defined in config.json on disk resolves a manifest and drives a run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "chit-roles-e2e-"));
		const prevXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = dir;
			mkdirSync(join(dir, "chit"), { recursive: true });
			writeFileSync(
				join(dir, "chit", "config.json"),
				JSON.stringify({
					roles: {
						reviewer: {
							agent: "codex",
							instructions: "Review the diff skeptically; approve only when correct.",
							session: "stateless",
							permissions: { filesystem: "read_only" },
						},
					},
				}),
			);

			const config = loadConfig();
			expect(config.roles.reviewer?.agent).toBe("codex");
			const manifest = resolveManifest(parseManifest(ONESHOT_ROLEREF), { roles: config.roles });

			const { adapters, seen } = capturingAdapter();
			const r = await runManifestOnce(manifest, {
				inputs: { q: "go" },
				registry: config.registry,
				invocationCwd: dir,
				surface: "mcp",
				adapters,
			});
			expect(r.ok).toBe(true);
			expect(seen[0]?.agentId).toBe("codex");
			expect(seen[0]?.input).toContain("Review the diff skeptically");
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("show: buildGraphModel surfaces the role's resolved agent, session, and instructions", () => {
		const manifest = resolveManifest(parseManifest(ONESHOT_ROLEREF), {
			roles: { reviewer: REVIEWER },
		});
		// No surface kind: participants are built regardless of validation surface, and
		// this asserts the resolved participant values, not surface validation.
		const model = buildGraphModel(manifest, parseRegistry(undefined));
		expect(model.participants.reviewer?.agentId).toBe("codex");
		expect(model.participants.reviewer?.session).toBe("stateless");
		expect(model.participants.reviewer?.instructions).toBe(REVIEWER.instructions);
		expect(model.participants.reviewer?.permissions.filesystem).toBe("read_only");
	});

	test("audit: the participant snapshot records the role's resolved values", () => {
		const manifest = resolveManifest(parseManifest(ONESHOT_ROLEREF), {
			roles: { reviewer: REVIEWER },
		});
		const snapshots = resolveParticipantSnapshots(manifest, parseRegistry(undefined));
		expect(snapshots.reviewer).toMatchObject({
			agentId: "codex",
			session: "stateless",
			permissions: { filesystem: "read_only" },
		});
	});
});
