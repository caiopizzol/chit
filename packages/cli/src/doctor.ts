// `chit doctor`: a cheap, safe readiness check for dropping chit into a real project.
// The schema and parser prove a config is well-formed; doctor proves the ENVIRONMENT can
// actually run it -- the CLIs are installed, the project is a git repo where sandboxing
// works, and the commands a check runs exist. It spends nothing: no model calls, no writes.
// (A future `--real` mode will make tiny real calls to confirm auth/model access and the
// read-only/read-write permission mappings; that one can cost money, so it stays opt-in.)
//
// The live probes are injected (DoctorProbes) so the whole pass is testable with fakes --
// the same discipline as the adapter/check/sandbox seams. The bin wires `realDoctorProbes`.

import { isBuiltInAdapter } from "./builtin-adapters.ts";
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
export async function runDoctor(cwd: string, probes: DoctorProbes): Promise<DoctorReport> {
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
	for (const adapter of adapters) {
		if (!isBuiltInAdapter(adapter)) {
			checks.push({ status: "warn", title: `adapter ${adapter}`, detail: "custom adapter; cannot probe for a CLI" });
			continue;
		}
		const exists = await probes.commandExists(adapter);
		checks.push(
			exists
				? { status: "pass", title: `adapter ${adapter}`, detail: "CLI found on PATH" }
				: { status: "fail", title: `adapter ${adapter}`, detail: `"${adapter}" CLI not found on PATH; a routine that calls it will fail` },
		);
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
