// Write-safety: a converge loop's read-write steps must never edit the caller's
// real tree. A Sandbox is an isolated working copy where the builder edits and
// checks run; the caller sees the diff and applies it back only on explicit
// confirm. Like the adapter and check-runner, it is a seam: a fake for tests, a
// real git-worktree implementation for the bin.

import { existsSync, lstatSync, mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	// Where steps run (passed as the adapter/check cwd). Edits here never touch origin.
	workDir: string;
	diff(): Promise<string>;
	diffStat(): Promise<string>;
	status(): Promise<string[]>;
	// Apply the sandbox's changes back to the origin tree. Caller gates this on confirm.
	apply(): Promise<void>;
	// Tear down without applying.
	discard(): Promise<void>;
}

export interface SandboxFactory {
	create(originCwd: string, runId: string): Promise<Sandbox>;
}

// --- fake (tests) ---

export interface FakeSandbox extends Sandbox {
	applied: boolean;
	discarded: boolean;
}

export function fakeSandbox(opts: { workDir?: string; diff?: string } = {}): FakeSandbox {
	const sb: FakeSandbox = {
		workDir: opts.workDir ?? "/sandbox",
		applied: false,
		discarded: false,
		async diff() {
			return opts.diff ?? "";
		},
		async diffStat() {
			return opts.diff ? " file | 1 +" : "";
		},
		async status() {
			return opts.diff ? ["M\tfile"] : [];
		},
		async apply() {
			sb.applied = true;
		},
		async discard() {
			sb.discarded = true;
		},
	};
	return sb;
}

export function fakeSandboxFactory(opts: { workDir?: string; diff?: string } = {}): SandboxFactory {
	return { async create() { return fakeSandbox(opts); } };
}

// --- real: git worktree ---

async function git(args: string[], cwd: string, stdin?: string): Promise<{ ok: boolean; out: string; err: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		...(stdin !== undefined ? { stdin: new TextEncoder().encode(stdin) } : {}),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { ok: code === 0, out, err };
}

async function gitOrThrow(args: string[], cwd: string, stdin?: string): Promise<string> {
	const r = await git(args, cwd, stdin);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${(r.err || r.out).trim()}`);
	return r.out;
}

// node_modules is gitignored, so a worktree from HEAD lacks it and checks that need
// deps would fail. Symlink it from origin and keep it out of every diff/stage.
const EXCLUDE_NM = ":(exclude)node_modules";

export const gitWorktreeSandboxFactory: SandboxFactory = {
	async create(originCwd, runId) {
		const head = await git(["rev-parse", "--show-toplevel"], originCwd);
		if (!head.ok) throw new Error(`converge needs a git repository to sandbox into (cwd: ${originCwd})`);
		const repoRoot = head.out.trim();
		const parent = mkdtempSync(join(tmpdir(), `chit-sbx-${runId}-`));
		const workDir = join(parent, "wt");
		await gitOrThrow(["worktree", "add", "--detach", workDir, "HEAD"], repoRoot);
		const nm = join(repoRoot, "node_modules");
		if (existsSync(nm) && !existsSync(join(workDir, "node_modules"))) {
			symlinkSync(nm, join(workDir, "node_modules"));
		}

		const stage = () => gitOrThrow(["add", "-A", "--", ".", EXCLUDE_NM], workDir);

		return {
			workDir,
			async diff() {
				await stage();
				return gitOrThrow(["diff", "--cached", "--", ".", EXCLUDE_NM], workDir);
			},
			async diffStat() {
				await stage();
				return (await gitOrThrow(["diff", "--cached", "--stat", "--", ".", EXCLUDE_NM], workDir)).trim();
			},
			async status() {
				await stage();
				const out = await gitOrThrow(["diff", "--cached", "--name-status", "--", ".", EXCLUDE_NM], workDir);
				return out.split("\n").filter(Boolean);
			},
			async apply() {
				await stage();
				const patch = await gitOrThrow(["diff", "--cached", "--binary", "--", ".", EXCLUDE_NM], workDir);
				if (patch.trim() === "") return;
				const r = await git(["apply", "--whitespace=nowarn"], repoRoot, patch);
				if (!r.ok) throw new Error(`could not apply sandbox changes to ${repoRoot}: ${r.err.trim()}`);
			},
			async discard() {
				const link = join(workDir, "node_modules");
				try {
					if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
				} catch {
					// no symlink to clean
				}
				await git(["worktree", "remove", "--force", workDir], repoRoot);
				await git(["worktree", "prune"], repoRoot);
			},
		};
	},
};
