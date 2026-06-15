// `chit doctor`: a cheap, safe readiness check for dropping chit into a real project.
// The schema and parser prove a config is well-formed; doctor proves the ENVIRONMENT can
// actually run it -- the CLIs are installed, the project is a git repo where sandboxing
// works, and the commands a check runs exist. It spends nothing: no model calls, no writes.
// `--real` (opt-in) goes further: a tiny real call per configured adapter confirms the CLI
// runs, auth works, and the model is accepted, plus a read-only call that must not write and a
// read-write call that must, confirming the permission mapping in THIS environment. It can
// spend model calls, so it never runs by default.
//
// Both live seams are injected -- DoctorProbes (PATH, git) and AdapterProbe (the real calls) --
// so the whole pass is testable with fakes. The bin wires realDoctorProbes + makeRealAdapterProbe.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry } from "./adapter.ts";
import { adapterSupportsFilesystem, isBuiltInAdapter } from "./builtin-adapters.ts";
import { type ChitConfig, ConfigError, loadConfig } from "./config.ts";
import { type Check, isSandboxed } from "./manifest.ts";
import { spawnCapture } from "./proc.ts";
import { type ResolvedRoutine, resolveRoutine } from "./routine.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	status: DoctorStatus;
	title: string;
	detail: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	// True when nothing failed (warnings are allowed). Drives the exit code.
	ok: boolean;
}

// The live environment seam. Real impl below; tests inject a fake so a doctor run is
// deterministic and never shells out.
export interface DoctorProbes {
	commandExists(cmd: string): Promise<boolean>;
	gitState(cwd: string): Promise<{ isRepo: boolean; clean: boolean }>;
}

// The real-call seam for `--real`. `reach` is one tiny read-only call (the CLI runs, auth works,
// the model is accepted); `permissions` confirms read-only cannot write and read-write can.
// Injected so the report logic is tested with a fake; makeRealAdapterProbe is the real version.
export interface AdapterProbe {
	reach(adapter: string, model: string | undefined): Promise<{ ok: boolean; detail: string }>;
	permissions(adapter: string, model: string | undefined): Promise<{ readOnlyHeld: boolean; readWriteWorked: boolean; detail: string }>;
}

// The binary a check actually invokes, best-effort. A string check "bun test" is stored as
// `sh -c "bun test"`, so the real command is the first token of the script, not `sh`. An
// argv check carries its command directly.
function checkBinary(c: Check): string {
	if (c.command === "sh" && c.args[0] === "-c" && typeof c.args[1] === "string") {
		const first = c.args[1].trim().split(/\s+/)[0];
		if (first) return first;
	}
	return c.command;
}

// Run the readiness pass over a project directory. Pure except for reading the config/manifest
// files (real, deterministic) and the injected probes; returns a structured report.
export async function runDoctor(cwd: string, probes: DoctorProbes, adapterProbe?: AdapterProbe): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];

	// 1. The config must parse and validate -- everything else reads from it.
	let config: ChitConfig;
	try {
		config = loadConfig(cwd);
	} catch (e) {
		const detail = e instanceof ConfigError ? e.detail : (e as Error).message;
		checks.push({ status: "fail", title: "config", detail });
		return { checks, ok: false };
	}
	checks.push({ status: "pass", title: "config", detail: "chit.config.json parses and validates" });

	// 2. Every declared routine must resolve (file-backed manifests read, profiles bound).
	const routineIds = Object.keys(config.routines);
	const resolved: ResolvedRoutine[] = [];
	let routineFails = 0;
	for (const id of routineIds) {
		try {
			resolved.push(resolveRoutine(config, id, cwd));
		} catch (e) {
			checks.push({ status: "fail", title: `routine ${id}`, detail: (e as Error).message });
			routineFails += 1;
		}
	}
	if (routineIds.length === 0) {
		checks.push({ status: "warn", title: "routines", detail: "no routines declared in chit.config.json" });
	} else if (routineFails === 0) {
		checks.push({ status: "pass", title: "routines", detail: `${routineIds.length} routine${routineIds.length === 1 ? "" : "s"} resolve` });
	}

	// 3. Each built-in adapter a profile binds must have its CLI installed. A custom adapter
	//    is opaque (we do not know its binary), so it is a warning, not a fail.
	const adapters = [...new Set(Object.values(config.agents).map((a) => a.adapter))].sort();
	const presentAdapters: string[] = [];
	for (const adapter of adapters) {
		if (!isBuiltInAdapter(adapter)) {
			checks.push({ status: "warn", title: `adapter ${adapter}`, detail: "custom adapter; cannot probe for a CLI" });
			continue;
		}
		if (await probes.commandExists(adapter)) {
			presentAdapters.push(adapter);
			checks.push({ status: "pass", title: `adapter ${adapter}`, detail: "CLI found on PATH" });
		} else {
			checks.push({ status: "fail", title: `adapter ${adapter}`, detail: `"${adapter}" CLI not found on PATH; a routine that calls it will fail` });
		}
	}

	// 3b. A participant's filesystem must be one its bound adapter can honor. codex has no
	//     no-tools mode, so codex + filesystem "none" throws at run time -- catch it before a run.
	for (const r of resolved) {
		for (const p of Object.values(r.manifest.participants)) {
			const binding = r.agents?.[p.agent];
			if (binding === undefined || adapterSupportsFilesystem(binding.adapter, p.filesystem)) continue;
			checks.push({
				status: "fail",
				title: `${r.id}.${p.id}`,
				detail: `${binding.adapter} cannot honor filesystem "${p.filesystem}"; use read-only or bind it to another adapter`,
			});
		}
	}

	// 4. The commands a check runs should exist. The binary extraction is best-effort, so a
	//    miss is a warning (the run is what truly proves it), not a hard fail.
	const bins = new Set<string>();
	for (const r of resolved) {
		for (const s of r.manifest.steps) {
			if (s.kind === "check") for (const c of s.checks) bins.add(checkBinary(c));
		}
	}
	for (const bin of [...bins].sort()) {
		const exists = await probes.commandExists(bin);
		checks.push(
			exists
				? { status: "pass", title: `check ${bin}`, detail: "found on PATH" }
				: { status: "warn", title: `check ${bin}`, detail: "not found on PATH; a check that runs it will fail" },
		);
	}

	// 5. A sandboxed routine runs in a git worktree off a clean HEAD, so the project must be a
	//    git repo. Dirty is a warning (the run's preflight will refuse until it is clean).
	if (resolved.some((r) => isSandboxed(r.manifest))) {
		const g = await probes.gitState(cwd);
		if (!g.isRepo) {
			checks.push({ status: "fail", title: "git", detail: "a sandboxed routine runs in a git worktree, but this is not a git repo" });
		} else if (!g.clean) {
			checks.push({ status: "warn", title: "git", detail: "working tree is dirty; a sandboxed run starts from a clean HEAD, so commit or stash first" });
		} else {
			checks.push({ status: "pass", title: "git", detail: "clean git repo; sandboxing can work" });
		}
	}

	// 6. --real: confirm the wired CLIs and configured models actually run here, and that the
	//    permission mapping holds. Opt-in (real model calls), so only when an adapterProbe is given.
	//    Probed per adapter that passed the PATH check above.
	if (adapterProbe !== undefined) {
		const modelsByAdapter = new Map<string, Set<string | undefined>>();
		for (const a of Object.values(config.agents)) {
			if (!presentAdapters.includes(a.adapter)) continue;
			const models = modelsByAdapter.get(a.adapter) ?? new Set<string | undefined>();
			models.add(a.model);
			modelsByAdapter.set(a.adapter, models);
		}
		for (const adapter of presentAdapters) {
			const models = modelsByAdapter.get(adapter);
			if (models === undefined) continue;
			let anyReachable = false;
			for (const model of models) {
				const label = model !== undefined && model !== "default" ? `${adapter}:${model}` : adapter;
				const r = await adapterProbe.reach(adapter, model);
				if (r.ok) {
					anyReachable = true;
					checks.push({ status: "pass", title: `real ${label}`, detail: `reachable, model accepted${r.detail ? ` (${r.detail})` : ""}` });
				} else {
					checks.push({ status: "fail", title: `real ${label}`, detail: `not reachable / model rejected: ${r.detail}` });
				}
			}
			// The permission mapping is adapter-level, so probe it once per adapter (first model),
			// and only if something was reachable -- no point write-testing an unreachable CLI.
			if (anyReachable) {
				const p = await adapterProbe.permissions(adapter, [...models][0]);
				checks.push(
					p.readOnlyHeld
						? { status: "pass", title: `real ${adapter} read-only`, detail: "no write got through" }
						: { status: "fail", title: `real ${adapter} read-only`, detail: "a write got through a read-only call" },
				);
				checks.push(
					p.readWriteWorked
						? { status: "pass", title: `real ${adapter} read-write`, detail: "wrote inside a temp sandbox" }
						: { status: "warn", title: `real ${adapter} read-write`, detail: "no file written (the model may have declined)" },
				);
			}
		}
	}

	return { checks, ok: !checks.some((c) => c.status === "fail") };
}

// Shape-coded status, matching the CLI/landing/audit grammar (pass / warn / fail).
const SHAPE: Record<DoctorStatus, string> = { pass: "●", warn: "○", fail: "◆" };

export function formatDoctor(report: DoctorReport): string {
	const out: string[] = ["chit doctor", ""];
	const w = Math.max(1, ...report.checks.map((c) => c.title.length));
	for (const c of report.checks) {
		out.push(`  ${SHAPE[c.status]} ${c.title.padEnd(w)}  ${c.detail}`);
	}
	out.push("");
	const fails = report.checks.filter((c) => c.status === "fail").length;
	const warns = report.checks.filter((c) => c.status === "warn").length;
	if (fails > 0) {
		out.push(`${fails} fail${fails === 1 ? "" : "s"}${warns > 0 ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}. fix the fails before a real run.`);
	} else if (warns > 0) {
		out.push(`ready, with ${warns} warning${warns === 1 ? "" : "s"} to review.`);
	} else {
		out.push("ready.");
	}
	return out.join("\n");
}

// The real environment probes for the bin. `Bun.which` resolves a binary on PATH without
// spawning anything; git state is two cheap reads. Wrapped so a missing `git` reads as
// "not a repo" rather than throwing. Tests never use this -- they inject a fake.
export const realDoctorProbes: DoctorProbes = {
	async commandExists(cmd) {
		return Bun.which(cmd) !== null;
	},
	async gitState(cwd) {
		try {
			const inside = await spawnCapture(["git", "rev-parse", "--is-inside-work-tree"], { cwd });
			if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { isRepo: false, clean: false };
			const status = await spawnCapture(["git", "status", "--porcelain"], { cwd });
			return { isRepo: true, clean: status.exitCode === 0 && status.stdout.trim() === "" };
		} catch {
			return { isRepo: false, clean: false };
		}
	},
};

// The real AdapterProbe for `--real`: tiny calls through the wired adapters in a temp dir,
// reading the permission mapping off whether a file actually appears. Expensive (model calls),
// so only the --real path builds it. Tests inject a fake AdapterProbe instead.
export function makeRealAdapterProbe(registry: AdapterRegistry): AdapterProbe {
	const TIMEOUT_MS = 90_000;
	return {
		async reach(adapter, model) {
			const a = registry[adapter];
			if (a === undefined) return { ok: false, detail: "adapter not wired" };
			const dir = mkdtempSync(join(tmpdir(), `chit-doctor-reach-${adapter}-`));
			try {
				const r = await a.call({
					agent: adapter,
					...(model !== undefined && { model }),
					instructions: "Connectivity check.",
					prompt: 'Reply with the single word "ok".',
					filesystem: "read-only",
					cwd: dir,
					timeoutMs: TIMEOUT_MS,
				});
				const out = r.output.trim();
				return { ok: out.length > 0, detail: out.slice(0, 40) || "(empty output)" };
			} catch (e) {
				return { ok: false, detail: (e as Error).message };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		async permissions(adapter, model) {
			const a = registry[adapter];
			if (a === undefined) return { readOnlyHeld: true, readWriteWorked: false, detail: "adapter not wired" };
			const dir = mkdtempSync(join(tmpdir(), `chit-doctor-perm-${adapter}-`));
			try {
				// read-only must NOT be able to write: ask it to, then confirm the file is absent.
				try {
					await a.call({
						agent: adapter,
						...(model !== undefined && { model }),
						instructions: "Permission check.",
						prompt: 'Create a file named ro.txt containing "x".',
						filesystem: "read-only",
						cwd: dir,
						timeoutMs: TIMEOUT_MS,
					});
				} catch {
					// A refusal is fine -- the file simply will not exist, which is the point.
				}
				const readOnlyHeld = !existsSync(join(dir, "ro.txt"));
				// read-write must be able to write: ask it to, then confirm the file appeared.
				try {
					await a.call({
						agent: adapter,
						...(model !== undefined && { model }),
						instructions: "Permission check.",
						prompt: 'Create a file named rw.txt containing "x".',
						filesystem: "read-write",
						cwd: dir,
						timeoutMs: TIMEOUT_MS,
					});
				} catch {
					// Surfaces as the file being absent below.
				}
				const readWriteWorked = existsSync(join(dir, "rw.txt"));
				return { readOnlyHeld, readWriteWorked, detail: "" };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}
