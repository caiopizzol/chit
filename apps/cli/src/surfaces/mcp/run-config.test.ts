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
// Three sibling temp "repos" (no .git: discovery falls back to the cwd itself)
// prove the three behaviors: the repo trust boundary fires from the tool-input
// cwd; a repo-defined role is actually applied; and the per-repo config cache
// keeps the two repos' configs apart within one server process.

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

	test("a repo without that config still fails on the unknown role (cache is per repo)", async () => {
		// Runs against the SAME server process as the test above: if the config cache
		// were global instead of keyed by repo, the previous repo's "ghost" role would
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
});
