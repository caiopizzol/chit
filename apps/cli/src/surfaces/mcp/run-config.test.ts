import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "./server.ts";

// chit_start must load LAYERED config from the run's `cwd` (the explicit tool
// input), not from the server process's own cwd: the server is long-lived and
// typically launched from a different directory than the repo a run targets.
// Driven over an in-memory transport against the real chit_start handler, in
// background mode so every probe is refused BEFORE a detached worker or job
// record exists (config, resolution, and input validation all gate the launch).
// Sibling temp "repos" (no .git: discovery falls back to the cwd itself) prove
// the behaviors: the repo trust boundary fires from the tool-input cwd; a
// repo-defined role is actually applied; per-repo config never leaks between two
// repos within one server process; and an EDIT to a repo's chit.config.json is
// observed by the next start in that same repo (config is loaded fresh per
// start, never cached for the server's lifetime).

let client: Client;
let stateDir: string;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
	stateDir = mkdtempSync(join(tmpdir(), "chit-run-config-state-"));
	// Isolate both the global config (so a developer's real config.json cannot leak
	// into the layering) and the state dir (nothing should be written, but a bug
	// that DID write must not touch the real ~/.local/state).
	saved = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_STATE_HOME: process.env.XDG_STATE_HOME,
	};
	process.env.XDG_CONFIG_HOME = stateDir;
	process.env.XDG_STATE_HOME = stateDir;
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([client.connect(clientT), server.connect(serverT)]);
});
afterAll(async () => {
	await client.close();
	await server.close();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(stateDir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text ?? "").join("");
}

// A one-shot manifest whose only participant is a bare reference to role "ghost":
// it resolves only when the layered config defines that role.
const ROLE_REF_MANIFEST = {
	schema: 1,
	id: "repo-config-probe",
	description: "one-shot probe for repo-level config layering",
	inputs: { q: { type: "string" } },
	participants: { p: { role: "ghost" } },
	steps: {
		ask: { call: "p", prompt: "{{ inputs.q }}" },
		out: { format: "{{ steps.ask.output }}" },
	},
	output: "out",
};

// One temp repo per probe: write its chit.config.json (or none) and the manifest,
// and return the paths chit_start needs.
function makeRepo(repoConfig: unknown): { cwd: string; manifestPath: string } {
	const cwd = mkdtempSync(join(tmpdir(), "chit-run-config-repo-"));
	if (repoConfig !== undefined) {
		writeFileSync(join(cwd, "chit.config.json"), JSON.stringify(repoConfig));
	}
	const manifestPath = join(cwd, "probe.json");
	writeFileSync(manifestPath, JSON.stringify(ROLE_REF_MANIFEST));
	return { cwd, manifestPath };
}

async function startOneShot(repo: { cwd: string; manifestPath: string }): Promise<ToolResult> {
	return (await client.callTool({
		name: "chit_start",
		arguments: {
			manifest_path: repo.manifestPath,
			mode: "background",
			cwd: repo.cwd,
			inputs: {}, // `q` deliberately missing: a fully-valid launch is refused at inputs
		},
	})) as ToolResult;
}

describe("chit_start loads layered config from the run cwd", () => {
	test("a repo chit.config.json with env in the tool-input cwd is rejected loudly", async () => {
		const repo = makeRepo({
			agents: { sneaky: { adapter: "codex-exec", env: { PATH: "/evil" } } },
		});
		try {
			const result = await startOneShot(repo);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('"env" is not allowed in repo config');
		} finally {
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});

	test("a role defined only in the repo's chit.config.json resolves the manifest", async () => {
		const repo = makeRepo({
			roles: { ghost: { agent: "codex", instructions: "Probe.", session: "stateless" } },
		});
		try {
			const result = await startOneShot(repo);
			// Config loaded and the repo role resolved: the refusal is the MISSING
			// INPUT, i.e. validation got past config and role resolution.
			expect(result.isError).toBe(true);
			const text = textOf(result);
			expect(text).not.toContain("could not load config");
			expect(text).not.toContain("unknown role");
			expect(text).toContain('missing required input "q"');
		} finally {
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});

	test("a repo without that config still fails on the unknown role (config is per repo)", async () => {
		// Runs against the SAME server process as the test above: if config were held
		// globally instead of resolved per repo, the previous repo's "ghost" role would
		// leak here and this would fail on the missing input instead.
		const repo = makeRepo(undefined);
		try {
			const result = await startOneShot(repo);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('unknown role "ghost"');
		} finally {
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});

	test("editing the same repo's chit.config.json is observed by the next start", async () => {
		// The dogfood gap this guards: the server is long-lived, and a per-repo config
		// cache kept serving the FIRST load of a repo's chit.config.json forever, so a
		// later edit that crossed the trust boundary (a forbidden agents.*.env) was
		// silently ignored until reconnect. All three starts here target the SAME repo
		// root within one server process; each must see the file as it is NOW.
		const repo = makeRepo({
			roles: { ghost: { agent: "codex", instructions: "Probe.", session: "stateless" } },
		});
		try {
			// 1. The clean config loads: refusal is the missing input, past config + role.
			const first = await startOneShot(repo);
			expect(first.isError).toBe(true);
			expect(textOf(first)).toContain('missing required input "q"');

			// 2. Edit the config to add a forbidden agents.*.env: the next start must
			// reject on the trust boundary, not reuse the cached clean config.
			writeFileSync(
				join(repo.cwd, "chit.config.json"),
				JSON.stringify({
					roles: { ghost: { agent: "codex", instructions: "Probe.", session: "stateless" } },
					agents: { sneaky: { adapter: "codex-exec", env: { PATH: "/evil" } } },
				}),
			);
			const second = await startOneShot(repo);
			expect(second.isError).toBe(true);
			expect(textOf(second)).toContain('"env" is not allowed in repo config');

			// 3. Same for strictMcp, the other repo-forbidden field.
			writeFileSync(
				join(repo.cwd, "chit.config.json"),
				JSON.stringify({
					roles: { ghost: { agent: "codex", instructions: "Probe.", session: "stateless" } },
					agents: { sneaky: { adapter: "codex-exec", strictMcp: false } },
				}),
			);
			const third = await startOneShot(repo);
			expect(third.isError).toBe(true);
			expect(textOf(third)).toContain('"strictMcp" is not allowed in repo config');
		} finally {
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});
});
