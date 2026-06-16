// Write-safety: a converge loop's read-write steps must never edit the caller's
// real tree. A Sandbox is an isolated working copy where the builder edits and
// checks run; the caller sees the diff and applies it back only on explicit
// confirm. Like the adapter and check-runner, it is a seam: a fake for tests, a
// real git-worktree implementation for the bin.

import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Sandbox {
	// Where steps run (passed as the adapter/check cwd). Edits here never touch origin.
	workDir: string;
	diff(): Promise<string>;
	diffStat(): Promise<string>;
	status(): Promise<string[]>;
	// The exact, re-appliable patch of the sandbox's changes (a git binary diff, so binary
	// files survive). Stored on a dry run so `chit apply <run-id>` can apply THIS reviewed
	// patch later, instead of re-running the models and producing a different diff.
	patch(): Promise<string>;
	// Apply the sandbox's changes back to the origin tree. Caller gates this on confirm.
	apply(): Promise<void>;
	// Tear down without applying.
	discard(): Promise<void>;
}

export interface SandboxFactory {
	// Precondition for sandboxing: the origin must be clean. A sandbox starts from HEAD, so
	// any uncommitted change would be invisible to the run AND could be clobbered when its
	// result is applied back. Throws DirtyWorktreeError if dirty; otherwise returns the base
	// commit the sandbox will start from (recorded on the receipt for a coherent apply later).
	preflight(originCwd: string): Promise<{ baseCommit: string }>;
	create(originCwd: string, runId: string): Promise<Sandbox>;
	// Apply a stored patch (from a prior dry run) back to the origin, the `chit apply` path.
	// Refuses unless HEAD still equals expectedBase AND the tree is clean AND the patch applies
	// cleanly -- so the operator applies EXACTLY the diff they reviewed, onto the same base.
	// Throws ApplyError (with operator-facing guidance) when a precondition fails.
	applyPatch(originCwd: string, patch: string, expectedBase: string): Promise<void>;
}

// The origin has uncommitted changes, so a HEAD-based sandbox would run on a different tree
// than the operator sees. Thrown by preflight; the CLI turns it into a clear refusal.
export class DirtyWorktreeError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = "DirtyWorktreeError";
	}
}

// A stored patch could not be applied: HEAD moved off the base, the tree is dirty, or the
// patch does not apply cleanly. Thrown by applyPatch; the CLI turns it into a clear message.
export class ApplyError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = "ApplyError";
	}
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
		async patch() {
			return opts.diff ?? "";
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

export function fakeSandboxFactory(
	opts: {
		workDir?: string;
		diff?: string;
		dirty?: boolean;
		baseCommit?: string;
		applyError?: string;
		onApplyPatch?: (patch: string, base: string) => void;
	} = {},
): SandboxFactory {
	return {
		async preflight() {
			if (opts.dirty)
				throw new DirtyWorktreeError("Sandboxed runs start from HEAD. Commit or stash your changes first.");
			return { baseCommit: opts.baseCommit ?? "base0000" };
		},
		async create() {
			return fakeSandbox(opts);
		},
		async applyPatch(_originCwd, patch, base) {
			if (opts.applyError) throw new ApplyError(opts.applyError);
			opts.onApplyPatch?.(patch, base);
		},
	};
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

// chit writes its own receipts/patches under .chit/. That bookkeeping is not the operator's
// uncommitted work, so it must never count as a "dirty" tree in the preflight / apply checks
// (a fresh repo where .chit is not gitignored would otherwise always look dirty).
const DIRTY_CHECK_PATHSPEC = ["--", ".", ":(exclude).chit", EXCLUDE_NM];

// The liveness lock filename inside a sandbox's parent dir. Holds the owning run's
// pid so `chit cleanup` can tell an interrupted-run leftover from a live sandbox.
const OWNER_LOCK = "owner.pid";

export const gitWorktreeSandboxFactory: SandboxFactory = {
	async preflight(originCwd) {
		const top = await git(["rev-parse", "--show-toplevel"], originCwd);
		if (!top.ok) throw new Error(`a sandboxed run needs a git repository (cwd: ${originCwd})`);
		const repoRoot = top.out.trim();
		// `git status --porcelain` reports tracked changes AND untracked files; we exclude
		// chit's own .chit/ (and node_modules). Any remaining output means the tree differs
		// from HEAD, which is exactly what makes a HEAD-based sandbox incoherent.
		const status = await gitOrThrow(["status", "--porcelain", ...DIRTY_CHECK_PATHSPEC], repoRoot);
		if (status.trim() !== "") {
			throw new DirtyWorktreeError("Sandboxed runs start from HEAD. Commit or stash your changes first.");
		}
		const base = (await gitOrThrow(["rev-parse", "HEAD"], repoRoot)).trim();
		return { baseCommit: base };
	},
	async create(originCwd, runId) {
		const head = await git(["rev-parse", "--show-toplevel"], originCwd);
		if (!head.ok) throw new Error(`converge needs a git repository to sandbox into (cwd: ${originCwd})`);
		const repoRoot = head.out.trim();
		const parent = mkdtempSync(join(tmpdir(), `chit-sbx-${runId}-`));
		const workDir = join(parent, "wt");
		// Write the liveness lock before the worktree exists, so any worktree that
		// `git worktree list` reports already carries one. cleanup keys off it.
		writeFileSync(join(parent, OWNER_LOCK), String(process.pid));
		await gitOrThrow(["worktree", "add", "--detach", workDir, "HEAD"], repoRoot);
		const nm = join(repoRoot, "node_modules");
		if (existsSync(nm) && !existsSync(join(workDir, "node_modules"))) {
			symlinkSync(nm, join(workDir, "node_modules"));
		}

		const stage = () => gitOrThrow(["add", "-A", "--", ".", EXCLUDE_NM], workDir);
		// The re-appliable patch: a staged binary diff. Used both to store (dry run) and to
		// apply (--auto-apply), so what `chit apply` re-plays is byte-identical to what ran here.
		const binaryPatch = async () => {
			await stage();
			return gitOrThrow(["diff", "--cached", "--binary", "--", ".", EXCLUDE_NM], workDir);
		};

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
			async patch() {
				return binaryPatch();
			},
			async apply() {
				const patch = await binaryPatch();
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
				rmSync(parent, { recursive: true, force: true });
			},
		};
	},
	async applyPatch(originCwd, patch, expectedBase) {
		const top = await git(["rev-parse", "--show-toplevel"], originCwd);
		if (!top.ok) throw new Error(`apply needs a git repository (cwd: ${originCwd})`);
		const repoRoot = top.out.trim();
		// Same base: the patch was cut against expectedBase; if HEAD has moved, the diff the
		// operator reviewed no longer describes a change onto THIS tree.
		const head = (await gitOrThrow(["rev-parse", "HEAD"], repoRoot)).trim();
		if (head !== expectedBase) {
			throw new ApplyError(
				`this patch was made against ${expectedBase.slice(0, 12)} but HEAD is now ${head.slice(0, 12)}. Re-run the routine on the current tree.`,
			);
		}
		// Clean tree: don't blend the reviewed patch with unrelated uncommitted edits (chit's
		// own .chit/ bookkeeping is excluded, so it never blocks an apply).
		const status = await gitOrThrow(["status", "--porcelain", ...DIRTY_CHECK_PATHSPEC], repoRoot);
		if (status.trim() !== "") throw new ApplyError("your tree has uncommitted changes. Commit or stash them first.");
		if (patch.trim() === "") throw new ApplyError("this run produced no changes to apply.");
		// Dry-run the apply before committing to it, so a non-applying patch fails cleanly.
		const check = await git(["apply", "--check", "--whitespace=nowarn"], repoRoot, patch);
		if (!check.ok) throw new ApplyError(`the patch does not apply cleanly: ${check.err.trim()}`);
		const r = await git(["apply", "--whitespace=nowarn"], repoRoot, patch);
		if (!r.ok) throw new ApplyError(`could not apply: ${r.err.trim()}`);
	},
};

// Reap sandbox worktrees left behind by an INTERRUPTED run (a force-kill skips the
// `finally { discard() }`). Considers only worktrees carrying the chit-sbx marker
// and -- crucially -- skips any whose owning run is still alive, so running
// `chit cleanup` mid-run cannot pull a live sandbox out from under it. Returns the
// paths removed. This is the `chit cleanup` path.
export async function reapStaleSandboxes(originCwd: string): Promise<string[]> {
	const top = await git(["rev-parse", "--show-toplevel"], originCwd);
	if (!top.ok) return [];
	const repoRoot = top.out.trim();
	const list = await git(["worktree", "list", "--porcelain"], repoRoot);
	if (!list.ok) return [];
	const removed: string[] = [];
	for (const line of list.out.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const path = line.slice("worktree ".length).trim();
		if (!path.includes("chit-sbx-")) continue;
		// A live owner means the run is still using this sandbox -- leave it. A missing
		// lock means a pre-lock or already-orphaned sandbox, which is safe to reap.
		if (ownerAlive(dirname(path))) continue;
		const r = await git(["worktree", "remove", "--force", path], repoRoot);
		if (r.ok) {
			removed.push(path);
			rmSync(dirname(path), { recursive: true, force: true });
		}
	}
	await git(["worktree", "prune"], repoRoot);
	return removed;
}

// Does the sandbox under `parent` still have a living owner? Reads the pid lock and
// probes it. No lock -> treat as not alive (reapable).
function ownerAlive(parent: string): boolean {
	const lock = join(parent, OWNER_LOCK);
	if (!existsSync(lock)) return false;
	const pid = Number.parseInt(readFileSync(lock, "utf-8").trim(), 10);
	return Number.isInteger(pid) && isProcessAlive(pid);
}

// signal 0 probes a pid without touching it: no throw -> alive; EPERM -> alive but
// owned by another user; ESRCH (or anything else) -> gone.
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}
