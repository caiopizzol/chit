import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./adapter.ts";
import { type AdapterProbe, type DoctorProbes, type DoctorReport, formatDoctor, makeRealAdapterProbe, runDoctor } from "./doctor.ts";

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

function fakeAdapterProbe(over: Partial<{ reachOk: boolean; readOnlyHeld: boolean; readWriteWorked: boolean }> = {}): AdapterProbe {
	return {
		reach: async () => ({ ok: over.reachOk ?? true, detail: "ok" }),
		permissions: async () => ({ readOnlyHeld: over.readOnlyHeld ?? true, readWriteWorked: over.readWriteWorked ?? true, detail: "" }),
	};
}

describe("runDoctor --real (injected AdapterProbe)", () => {
	test("real checks pass for reachable adapters whose permissions hold", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"] }), fakeAdapterProbe());
		expect(statusOf(r, "real codex:gpt-5.5")).toBe("pass");
		expect(statusOf(r, "real gemini")).toBe("pass");
		expect(statusOf(r, "real codex read-only")).toBe("pass");
		expect(statusOf(r, "real codex read-write")).toBe("pass");
		expect(r.ok).toBe(true);
	});

	test("an unreachable adapter / rejected model fails, and its permission probes are skipped", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"] }), fakeAdapterProbe({ reachOk: false }));
		expect(statusOf(r, "real codex:gpt-5.5")).toBe("fail");
		expect(hasTitle(r, "real codex read-only")).toBe(false);
		expect(r.ok).toBe(false);
	});

	test("a write leaking through a read-only call is a fail", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"] }), fakeAdapterProbe({ readOnlyHeld: false }));
		expect(statusOf(r, "real codex read-only")).toBe("fail");
		expect(r.ok).toBe(false);
	});

	test("read-write writing nothing is a warning, not a fail", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"] }), fakeAdapterProbe({ readWriteWorked: false }));
		expect(statusOf(r, "real codex read-write")).toBe("warn");
		expect(r.ok).toBe(true);
	});

	test("default doctor (no AdapterProbe) runs no real checks", async () => {
		const dir = project(SANDBOXED);
		const r = await runDoctor(dir, fakeProbes({ has: ["codex", "gemini", "true"] }));
		expect(r.checks.some((c) => c.title.startsWith("real "))).toBe(false);
	});
});

describe("makeRealAdapterProbe (mechanics over fake adapters)", () => {
	test("reads the permission mapping off real files: read-only holds, read-write writes", async () => {
		const writing: Adapter = {
			async call(req) {
				// a write-capable model writes only when granted read-write
				if (req.filesystem === "read-write") writeFileSync(join(req.cwd, "rw.txt"), "x");
				return { output: "ok" };
			},
		};
		const probe = makeRealAdapterProbe({ codex: writing });
		expect((await probe.reach("codex", "gpt-5.5")).ok).toBe(true);
		const p = await probe.permissions("codex", "gpt-5.5");
		expect(p.readOnlyHeld).toBe(true);
		expect(p.readWriteWorked).toBe(true);
	});

	test("detects a write that leaks through a read-only call", async () => {
		const leaky: Adapter = {
			async call(req) {
				writeFileSync(join(req.cwd, req.filesystem === "read-only" ? "ro.txt" : "rw.txt"), "x");
				return { output: "ok" };
			},
		};
		const p = await makeRealAdapterProbe({ x: leaky }).permissions("x", undefined);
		expect(p.readOnlyHeld).toBe(false);
	});

	test("an adapter error makes reach not ok and surfaces the message", async () => {
		const dead: Adapter = {
			async call() {
				throw new Error("not authenticated");
			},
		};
		const r = await makeRealAdapterProbe({ x: dead }).reach("x", undefined);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("not authenticated");
	});

	test("an unwired adapter reports not wired", async () => {
		const r = await makeRealAdapterProbe({}).reach("ghost", undefined);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("not wired");
	});
});
