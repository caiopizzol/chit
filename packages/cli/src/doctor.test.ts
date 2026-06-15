import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorProbes, type DoctorReport, formatDoctor, runDoctor } from "./doctor.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A temp project with a chit.config.json. doctor reads real files, so the config must be on disk.
function project(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "chit-doctor-"));
	dirs.push(dir);
	writeFileSync(join(dir, "chit.config.json"), JSON.stringify(config, null, 2));
	return dir;
}

function fakeProbes(opts: { has?: string[]; isRepo?: boolean; clean?: boolean }): DoctorProbes {
	const has = new Set(opts.has ?? []);
	return {
		commandExists: async (cmd) => has.has(cmd),
		gitState: async () => ({ isRepo: opts.isRepo ?? true, clean: opts.clean ?? true }),
	};
}

const statusOf = (r: DoctorReport, title: string) => r.checks.find((c) => c.title === title)?.status;
const hasTitle = (r: DoctorReport, title: string) => r.checks.some((c) => c.title === title);

// A sandboxed loop: read-write builder (codex) + read-only critic (gemini) + a check.
const SANDBOXED = {
	profiles: { builder: "codex:gpt-5.5", critic: "gemini" },
	routines: {
		implement: {
			input: "task",
			agents: {
				builder: { profile: "builder", instructions: "Build.", filesystem: "read-write" },
				critic: { profile: "critic", instructions: "Review.", filesystem: "read-only" },
			},
			steps: [
				{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
				{ id: "verify", check: "true" },
			],
			repeat: { until: "checks-pass", maxIterations: 3 },
		},
	},
};

describe("runDoctor", () => {
	test("a ready project: config, routines, adapters, check, and git all pass", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"], isRepo: true, clean: true }));
		expect(r.ok).toBe(true);
		expect(r.checks.some((c) => c.status === "fail")).toBe(false);
		expect(statusOf(r, "config")).toBe("pass");
		expect(statusOf(r, "routines")).toBe("pass");
		expect(statusOf(r, "adapter codex")).toBe("pass");
		expect(statusOf(r, "adapter gemini")).toBe("pass");
		expect(statusOf(r, "check true")).toBe("pass");
		expect(statusOf(r, "git")).toBe("pass");
	});

	test("a missing adapter CLI is a fail", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["gemini", "true"] }));
		expect(statusOf(r, "adapter codex")).toBe("fail");
		expect(statusOf(r, "adapter gemini")).toBe("pass");
		expect(r.ok).toBe(false);
	});

	test("a sandboxed routine in a non-repo fails the git check", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"], isRepo: false }));
		expect(statusOf(r, "git")).toBe("fail");
		expect(r.ok).toBe(false);
	});

	test("a dirty worktree is a warning, not a fail", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"], isRepo: true, clean: false }));
		expect(statusOf(r, "git")).toBe("warn");
		expect(r.ok).toBe(true);
	});

	test("a missing check command is a warning (binary extraction is best-effort)", async () => {
		const dir = project({
			profiles: { builder: "codex:gpt-5.5" },
			routines: {
				verify: {
					agents: { builder: { profile: "builder", instructions: "Build.", filesystem: "read-write" } },
					steps: [
						{ id: "build", call: "builder", prompt: "go" },
						{ id: "test", check: "bun test" },
					],
					repeat: { until: "checks-pass", maxIterations: 2 },
				},
			},
		});
		const r = await runDoctor(dir, fakeProbes({ has: ["codex"] })); // no bun
		expect(statusOf(r, "check bun")).toBe("warn");
		expect(r.ok).toBe(true);
	});

	test("an impossible config fails fast and stops before other checks", async () => {
		const dir = project({ profiles: { x: "codex:sonnet" }, routines: {} });
		const r = await runDoctor(dir, fakeProbes({}));
		expect(statusOf(r, "config")).toBe("fail");
		expect(r.ok).toBe(false);
		expect(r.checks).toHaveLength(1);
	});

	test("no config at all is a fail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "chit-doctor-empty-"));
		dirs.push(dir);
		const r = await runDoctor(dir, fakeProbes({}));
		expect(statusOf(r, "config")).toBe("fail");
		expect(r.ok).toBe(false);
	});

	test("a custom adapter is a warning, and a read-only text routine skips the git check", async () => {
		const dir = project({
			profiles: { x: { adapter: "my-adapter", model: "m" } },
			routines: {
				chat: {
					input: "q",
					agents: { x: { profile: "x", instructions: "Answer.", filesystem: "read-only" } },
					steps: [{ id: "a", call: "x", prompt: "{{ inputs.q }}" }],
				},
			},
		});
		const r = await runDoctor(dir, fakeProbes({ has: [] }));
		expect(statusOf(r, "adapter my-adapter")).toBe("warn");
		expect(hasTitle(r, "git")).toBe(false); // not sandboxed
		expect(r.ok).toBe(true);
	});
});

describe("formatDoctor", () => {
	test("renders shape-coded rows and a fail summary", () => {
		const report: DoctorReport = {
			ok: false,
			checks: [
				{ status: "pass", title: "config", detail: "ok" },
				{ status: "warn", title: "check bun", detail: "missing" },
				{ status: "fail", title: "adapter codex", detail: "missing" },
			],
		};
		const text = formatDoctor(report);
		expect(text).toContain("● config");
		expect(text).toContain("○ check bun");
		expect(text).toContain("◆ adapter codex");
		expect(text).toContain("1 fail, 1 warning. fix the fails before a real run.");
	});

	test("summarizes a clean pass and a warn-only run", () => {
		expect(formatDoctor({ ok: true, checks: [{ status: "pass", title: "config", detail: "ok" }] })).toContain("ready.");
		expect(formatDoctor({ ok: true, checks: [{ status: "warn", title: "git", detail: "dirty" }] })).toContain("ready, with 1 warning to review.");
	});
});
