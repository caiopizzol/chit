// `chit campaign <start|status|run|inspect>` — an experimental local coordinator
// that runs several `chit converge` loops across a small set of GitHub issues,
// one git worktree per task. Dogfood-only; see notes/campaign-v0.md.
//
// It owns its own flag parsing and is delegated to from runMain, like loop-log
// and converge. All side effects (GitHub, git, the converge run) go through
// injected boundaries (CampaignDeps) so the orchestration is unit-tested with
// fakes — no GitHub, no real agents, no real worktrees.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { findClaimOverlaps, type IssueInput, planTasks } from "../campaigns/plan.ts";
import { deriveCampaignStatus, selectRunnable } from "../campaigns/schedule.ts";
import {
	CampaignStoreError,
	campaignExists,
	createCampaign,
	readCampaign,
	writeCampaign,
} from "../campaigns/store.ts";
import {
	type Campaign,
	type CampaignTask,
	MAX_PARALLEL_CAP,
	type TaskResult,
	type TaskStatus,
} from "../campaigns/types.ts";
import {
	assertClean,
	cleanupInstructions,
	ensureWorktree,
	type GitRunner,
	realGit,
	repoName,
	resolveBaseSha,
	taskWorktree,
	WorktreeError,
	worktreeRoot,
} from "../campaigns/worktree.ts";
import { readLoop } from "../loops/log-store.ts";
import { runConverge } from "./converge.ts";

export interface CampaignIO {
	out: (s: string) => void;
	err: (s: string) => void;
}

const defaultIO: CampaignIO = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(s),
};

// What the converge run left behind for one task, read back from its loop log.
export interface TaskRunOutcome {
	loopStatus: "converged" | "blocked" | "max-iterations";
	finalVerdict?: "proceed" | "revise" | "block";
	iterations: number;
	changedFiles: string[];
	auditRunIds: string[];
	summary: string;
	// The converge run itself failed (non-zero exit / threw / no loop log), as
	// opposed to a clean blocked/max-iterations outcome.
	runFailed?: boolean;
	error?: string;
}

export interface TaskRunParams {
	cwd: string; // the task worktree
	scope: string;
	task: string;
	maxIterations: number;
	loopId: string;
}

// Injected boundaries. Defaults hit GitHub (gh), git, and the real converge
// driver; tests override them.
export interface CampaignDeps {
	fetchIssue: (n: number) => Promise<IssueInput>;
	runTask: (params: TaskRunParams) => Promise<TaskRunOutcome>;
	git: GitRunner;
	now: () => number;
	worktreeRootDir: string;
}

class UsageError extends Error {}
class CampaignError extends Error {}

// --- default boundaries ---

function defaultFetchIssue(n: number): Promise<IssueInput> {
	return Promise.resolve().then(() => {
		let out: string;
		try {
			out = execFileSync("gh", ["issue", "view", String(n), "--json", "number,title,body"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			const err = e as { stderr?: string | Buffer };
			throw new CampaignError(
				`failed to fetch issue #${n} via gh: ${String(err.stderr ?? (e as Error).message).split("\n")[0]}`,
			);
		}
		const j = JSON.parse(out) as { number: number; title: string; body?: string };
		return { number: j.number, title: j.title, body: j.body ?? "" };
	});
}

// Default task runner: invoke the real converge driver in-process against the
// task's worktree, then read its loop log to derive the outcome.
async function defaultRunTask(params: TaskRunParams): Promise<TaskRunOutcome> {
	const captured: string[] = [];
	const io = { out: (s: string) => captured.push(s), err: (s: string) => captured.push(s) };
	let code: number;
	try {
		code = await runConverge(
			[
				"--task",
				params.task,
				"--scope",
				params.scope,
				"--cwd",
				params.cwd,
				"--max-iterations",
				String(params.maxIterations),
				"--loop-id",
				params.loopId,
			],
			io,
		);
	} catch (e) {
		return blankOutcome({ runFailed: true, error: (e as Error).message });
	}

	let records: ReturnType<typeof readLoop>;
	try {
		records = readLoop(params.cwd, params.loopId);
	} catch (e) {
		// converge ran but left no readable loop log (e.g. refused before starting).
		const line = captured
			.join("")
			.split("\n")
			.find((l) => l.includes("chit converge:"));
		return blankOutcome({ runFailed: true, error: line ?? (e as Error).message });
	}
	return outcomeFromLoop(records, code, captured);
}

function blankOutcome(over: Partial<TaskRunOutcome>): TaskRunOutcome {
	return {
		loopStatus: "blocked",
		iterations: 0,
		changedFiles: [],
		auditRunIds: [],
		summary: "",
		...over,
	};
}

// Reduce a converge loop log into a task outcome. Exported for tests.
export function outcomeFromLoop(
	records: ReturnType<typeof readLoop>,
	convergeExitCode: number,
	capturedOutput: string[] = [],
): TaskRunOutcome {
	const iterations = records.filter((r) => r.type === "iteration");
	const last = iterations[iterations.length - 1];
	const stop = records.find((r) => r.type === "stop");
	const rawStatus = stop?.type === "stop" ? stop.status : undefined;
	const loopStatus: TaskRunOutcome["loopStatus"] =
		rawStatus === "converged" || rawStatus === "max-iterations" ? rawStatus : "blocked";

	const auditRunIds = [
		...new Set(
			iterations
				.map((it) => (it.type === "iteration" ? it.detailsRef : undefined))
				.filter((r): r is string => typeof r === "string" && r.startsWith("audit:"))
				.map((r) => r.slice("audit:".length)),
		),
	];

	const outcome: TaskRunOutcome = {
		loopStatus,
		iterations: iterations.length,
		changedFiles: last?.type === "iteration" ? last.changedFiles : [],
		auditRunIds,
		summary: last?.type === "iteration" ? last.implementSummary : "",
	};
	if (last?.type === "iteration") outcome.finalVerdict = last.verdict;

	// A non-zero converge exit means the run itself failed (a manifest run error),
	// not a clean blocked/max-iterations verdict. Surface it as runFailed.
	if (convergeExitCode !== 0) {
		outcome.runFailed = true;
		outcome.error =
			capturedOutput
				.join("")
				.split("\n")
				.find((l) => l.includes("chit converge:")) ?? `converge exited ${convergeExitCode}`;
	}
	return outcome;
}

function defaultDeps(): CampaignDeps {
	return {
		fetchIssue: defaultFetchIssue,
		runTask: defaultRunTask,
		git: realGit,
		now: () => Date.now(),
		worktreeRootDir: worktreeRoot(),
	};
}

// --- arg parsing ---

const ALLOWED: Record<
	string,
	{ flags: readonly string[]; bools: readonly string[]; multi: readonly string[] }
> = {
	start: { flags: ["issues", "base", "max-parallel", "id", "repo"], bools: [], multi: ["claim"] },
	status: { flags: ["repo"], bools: [], multi: [] },
	run: {
		flags: ["repo", "max-iterations"],
		bools: ["reuse-worktree", "reuse-branch", "allow-dirty"],
		multi: [],
	},
	inspect: { flags: ["repo", "task"], bools: [], multi: [] },
};

const CAMPAIGN_HELP = `chit campaign <start|status|run|inspect> [flags]   (experimental, dogfood-only)

  start    --issues <n,...> [--claim <task-id>=<paths>] [--base <branch>] [--max-parallel <n>] [--id <id>] [--repo <dir>]
  status   <campaign-id> [--repo <dir>]
  run      <campaign-id> [--max-iterations <n>] [--reuse-worktree] [--reuse-branch] [--allow-dirty] [--repo <dir>]
  inspect  <campaign-id> --task <task-id> [--repo <dir>]

Coordinates several 'chit converge' runs across GitHub issues, one git worktree
per task. Never auto-merges or auto-pushes. --max-parallel is capped at ${MAX_PARALLEL_CAP}.
Path claims come from the issue TITLE only; classify a task the heuristic
misses with --claim issue-9=README.md,notes/** (repeatable). State lives in
<repo>/.chit/campaigns/<id>.json. See notes/campaign-v0.md.
`;

interface Parsed {
	positional?: string;
	flags: Record<string, string>;
	bools: Set<string>;
	// Repeatable flags, collected in order (e.g. --claim).
	multi: Record<string, string[]>;
}

function parseFlags(verb: string, argv: string[]): Parsed {
	const allowed = ALLOWED[verb];
	if (!allowed) throw new UsageError(`unknown subcommand "${verb}" (use start|status|run|inspect)`);
	const allowedFlags = new Set(allowed.flags);
	const allowedBools = new Set(allowed.bools);
	const allowedMulti = new Set(allowed.multi);
	const flags: Record<string, string> = {};
	const bools = new Set<string>();
	const multi: Record<string, string[]> = {};
	let positional: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (!a.startsWith("--")) {
			if (positional !== undefined) throw new UsageError(`unexpected argument "${a}"`);
			positional = a;
			continue;
		}
		const key = a.slice(2);
		if (allowedBools.has(key)) {
			bools.add(key);
			continue;
		}
		const isMulti = allowedMulti.has(key);
		if (!isMulti && !allowedFlags.has(key)) {
			throw new UsageError(`unknown flag --${key} for campaign ${verb}`);
		}
		const v = argv[++i];
		if (v === undefined) throw new UsageError(`--${key} requires a value`);
		if (isMulti) {
			const arr = multi[key] ?? [];
			arr.push(v);
			multi[key] = arr;
		} else {
			flags[key] = v;
		}
	}
	return { positional, flags, bools, multi };
}

// Parse repeatable --claim values of the form "<task-id>=<comma,paths>" into a
// map. Rejects malformed entries so a typo fails loudly rather than silently
// leaving a task unclassified.
function parseClaims(p: Parsed): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const raw of p.multi.claim ?? []) {
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			throw new UsageError(`--claim must be <task-id>=<paths> (got ${JSON.stringify(raw)})`);
		}
		const taskId = raw.slice(0, eq).trim();
		const paths = raw
			.slice(eq + 1)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (paths.length === 0) {
			throw new UsageError(`--claim ${taskId} needs at least one path`);
		}
		out[taskId] = paths;
	}
	return out;
}

function parseIssues(raw: string): number[] {
	const nums = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (nums.length === 0) throw new UsageError("--issues must list at least one issue number");
	return nums.map((s) => {
		const n = Number(s);
		if (!Number.isInteger(n) || n < 1) {
			throw new UsageError(`--issues must be positive integers (got ${JSON.stringify(s)})`);
		}
		return n;
	});
}

function intFlag(p: Parsed, key: string, fallback: number, min: number): number {
	const raw = p.flags[key];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) {
		throw new UsageError(`--${key} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
	}
	return n;
}

function resolveRepo(git: GitRunner, p: Parsed): string {
	const start = resolve(p.flags.repo ?? ".");
	const r = git(["rev-parse", "--show-toplevel"], start);
	if (r.code !== 0) throw new CampaignError(`not a git repository: ${start}`);
	return r.stdout.trim();
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// loop id for a task: campaign id + task id, both already filesystem-safe.
function taskLoopId(campaignId: string, taskId: string): string {
	return `${campaignId}-${taskId}`;
}

// --- verbs ---

async function doStart(p: Parsed, io: CampaignIO, deps: CampaignDeps): Promise<number> {
	const issues = parseIssues(req(p, "issues", "start"));
	const base = p.flags.base ?? "main";
	const maxParallel = intFlag(p, "max-parallel", 1, 1);
	if (maxParallel > MAX_PARALLEL_CAP) {
		throw new UsageError(`--max-parallel is capped at ${MAX_PARALLEL_CAP} in v0`);
	}
	const repo = resolveRepo(deps.git, p);
	const baseSha = resolveBaseSha(deps.git, repo, base);
	const id = p.flags.id ?? `campaign-${baseSha.slice(0, 8)}`;

	if (campaignExists(repo, id)) {
		throw new CampaignError(
			`campaign ${JSON.stringify(id)} already exists in ${repo} (pick another --id)`,
		);
	}

	const claims = parseClaims(p);
	// A --claim for an issue not in this campaign is almost certainly a typo.
	const issueIds = new Set(issues.map((n) => `issue-${n}`));
	for (const taskId of Object.keys(claims)) {
		if (!issueIds.has(taskId)) {
			throw new UsageError(
				`--claim ${taskId}: no such task (issues are ${[...issueIds].join(", ")})`,
			);
		}
	}

	const fetched: IssueInput[] = [];
	for (const n of issues) fetched.push(await deps.fetchIssue(n));
	const tasks = planTasks(fetched, claims);

	const overlaps = findClaimOverlaps(tasks);
	if (overlaps.length > 0) {
		io.err("chit campaign: refusing to start — tasks claim overlapping paths:\n");
		for (const o of overlaps) io.err(`  ${o.a} and ${o.b}\n`);
		io.err("\nSplit the issues so their file claims do not overlap, then start again.\n");
		return 1;
	}

	const nowIso = iso(deps.now());
	const campaign: Campaign = {
		schema: 1,
		id,
		repo,
		baseBranch: base,
		baseSha,
		maxParallel,
		createdAt: nowIso,
		updatedAt: nowIso,
		status: "planning",
		tasks,
	};
	campaign.status = deriveCampaignStatus(campaign);
	createCampaign(campaign);

	io.out(`chit campaign: created ${id}\n`);
	io.out(`  repo ${repo}\n`);
	io.out(`  base ${base}@${baseSha.slice(0, 7)}\n`);
	io.out(`  tasks ${tasks.length}, max-parallel ${maxParallel}\n`);
	for (const t of tasks) {
		io.out(`  ${t.id.padEnd(10)} ${t.status}${t.error ? ` (${t.error})` : ""}\n`);
	}
	const human = tasks.filter((t) => t.status === "needs_human");
	if (human.length > 0) {
		io.out(`\n${human.length} task(s) need manual classification before they can run.\n`);
	}
	if (tasks.some((t) => t.dependencies.length > 0)) {
		io.out(
			"\nNote: v0 does not track merges, so dependent tasks never auto-run. Run and\nmerge their dependencies yourself first, then re-run the campaign.\n",
		);
	}
	io.out(`\nRun it with: chit campaign run ${id}\n`);
	return 0;
}

function doStatus(p: Parsed, io: CampaignIO, deps: CampaignDeps): number {
	const id = reqPositional(p, "status <campaign-id>");
	const repo = resolveRepo(deps.git, p);
	const campaign = readCampaign(repo, id);
	io.out(renderStatus(campaign));
	return 0;
}

async function doRun(p: Parsed, io: CampaignIO, deps: CampaignDeps): Promise<number> {
	const id = reqPositional(p, "run <campaign-id>");
	const repo = resolveRepo(deps.git, p);
	const maxIterations = intFlag(p, "max-iterations", 3, 1);
	const reuseWorktree = p.bools.has("reuse-worktree");
	const reuseBranch = p.bools.has("reuse-branch");
	const allowDirty = p.bools.has("allow-dirty");

	const campaign = readCampaign(repo, id);

	// Reconcile a stale "running" task from a previous crashed run: no daemon
	// exists, so any running task on disk did not finish. Reset it to pending so
	// the run is resumable, and tell the operator.
	for (const t of campaign.tasks) {
		if (t.status === "running") {
			io.err(
				`chit campaign: task ${t.id} was left running by a previous run; resetting to pending\n`,
			);
			t.status = "pending";
		}
	}

	const root = deps.worktreeRootDir;
	let ranAny = false;
	// Each batch moves >=1 pending task to a terminal state, so pending strictly
	// shrinks; the guard is a backstop against a logic error, not normal flow.
	for (let guard = 0; guard <= campaign.tasks.length; guard++) {
		const batch = selectRunnable(campaign);
		if (batch.length === 0) break;

		// Mark the batch running and persist, so a concurrent `status` sees it.
		for (const t of batch) t.status = "running";
		stamp(campaign, deps);
		writeCampaign(campaign);

		const outcomes = await Promise.all(
			batch.map((t) =>
				runOneTask(
					t,
					campaign,
					{ repo, root, maxIterations, reuseWorktree, reuseBranch, allowDirty },
					io,
					deps,
				),
			),
		);
		for (const o of outcomes) applyOutcome(campaign, o);
		ranAny = true;
		stamp(campaign, deps);
		writeCampaign(campaign);
	}

	campaign.status = deriveCampaignStatus(campaign);
	stamp(campaign, deps);
	writeCampaign(campaign);

	if (!ranAny) {
		io.out(`chit campaign: nothing runnable in ${id} (status ${campaign.status})\n`);
	}
	io.out(renderStatus(campaign));
	io.out(renderNextActions(campaign));
	return 0;
}

function doInspect(p: Parsed, io: CampaignIO, deps: CampaignDeps): number {
	const id = reqPositional(p, "inspect <campaign-id>");
	const repo = resolveRepo(deps.git, p);
	const taskId = req(p, "task", "inspect");
	const campaign = readCampaign(repo, id);
	const task = campaign.tasks.find((t) => t.id === taskId);
	if (!task) throw new CampaignError(`campaign ${id} has no task ${JSON.stringify(taskId)}`);

	io.out(`task ${task.id}  [ ${task.status} ]\n`);
	if (task.issueNumber) io.out(`  issue   #${task.issueNumber}: ${task.title}\n`);
	if (task.branch) io.out(`  branch  ${task.branch}\n`);
	if (task.worktreePath) io.out(`  worktree ${task.worktreePath}\n`);
	if (task.loopId) {
		io.out(`  loop    ${task.loopId}\n`);
		io.out(`  loop log ${task.worktreePath ?? repo}/.chit/loops/${task.loopId}.jsonl\n`);
	}
	io.out(`  claims  ${task.claimedPaths.join(", ") || "(none)"}\n`);
	if (task.dependencies.length > 0) io.out(`  depends ${task.dependencies.join(", ")}\n`);
	if (task.result) {
		const r = task.result;
		io.out(
			`  result  ${r.loopStatus}, ${r.iterations} iteration(s)${r.finalVerdict ? `, verdict ${r.finalVerdict}` : ""}\n`,
		);
		io.out(
			`  changed ${r.changedFiles.length} file(s)${r.changedFiles.length ? `: ${r.changedFiles.join(", ")}` : ""}\n`,
		);
		for (const runId of r.auditRunIds) io.out(`  audit   chit audit show ${runId}\n`);
		if (r.summary) io.out(`  summary ${r.summary}\n`);
	}
	if (task.error) io.out(`  error   ${task.error}\n`);
	return 0;
}

// --- run helpers ---

interface RunContext {
	repo: string;
	root: string;
	maxIterations: number;
	reuseWorktree: boolean;
	reuseBranch: boolean;
	allowDirty: boolean;
}

interface TaskUpdate {
	taskId: string;
	status: TaskStatus;
	worktreePath: string;
	branch: string;
	loopId?: string;
	result?: TaskResult;
	error?: string;
	claimedPaths?: string[];
}

async function runOneTask(
	task: CampaignTask,
	campaign: Campaign,
	ctx: RunContext,
	io: CampaignIO,
	deps: CampaignDeps,
): Promise<TaskUpdate> {
	const { worktreePath, branch } = taskWorktree(ctx.root, repoName(ctx.repo), campaign.id, task.id);
	const loopId = taskLoopId(campaign.id, task.id);

	// Worktree setup problems are operational (needs a human), so they map to
	// blocked, not failed (which is reserved for a converge run that itself fails).
	try {
		ensureWorktree({
			git: deps.git,
			repo: ctx.repo,
			worktreePath,
			branch,
			baseSha: campaign.baseSha,
			reuseWorktree: ctx.reuseWorktree,
			reuseBranch: ctx.reuseBranch,
		});
		if (!ctx.allowDirty) assertClean(deps.git, worktreePath);
	} catch (e) {
		io.err(`chit campaign: ${task.id}: ${(e as Error).message}\n`);
		return {
			taskId: task.id,
			status: "blocked",
			worktreePath,
			branch,
			error: (e as Error).message,
		};
	}

	const taskText = `${task.title}\n\n${task.body}`.trim();
	io.out(`chit campaign: running ${task.id} in ${worktreePath}\n`);
	const outcome = await deps.runTask({
		cwd: worktreePath,
		scope: `campaign-${campaign.id}-${task.id}`,
		task: taskText,
		maxIterations: ctx.maxIterations,
		loopId,
	});

	const status: TaskStatus = outcome.runFailed
		? "failed"
		: outcome.loopStatus === "converged"
			? "review_ready"
			: "blocked";

	const result: TaskResult = {
		loopStatus: outcome.loopStatus,
		iterations: outcome.iterations,
		changedFiles: outcome.changedFiles,
		auditRunIds: outcome.auditRunIds,
		summary: outcome.summary,
	};
	if (outcome.finalVerdict) result.finalVerdict = outcome.finalVerdict;

	const update: TaskUpdate = { taskId: task.id, status, worktreePath, branch, loopId, result };
	if (outcome.error) update.error = outcome.error;
	// Replace the heuristic claims with the actual change set so later scheduling
	// uses real paths. Only when the run produced one.
	if (outcome.changedFiles.length > 0) update.claimedPaths = outcome.changedFiles;
	return update;
}

function applyOutcome(campaign: Campaign, u: TaskUpdate): void {
	const t = campaign.tasks.find((x) => x.id === u.taskId);
	if (!t) return;
	t.status = u.status;
	t.worktreePath = u.worktreePath;
	t.branch = u.branch;
	if (u.loopId) t.loopId = u.loopId;
	if (u.result) t.result = u.result;
	if (u.error) t.error = u.error;
	else delete t.error;
	if (u.claimedPaths) t.claimedPaths = u.claimedPaths;
}

function stamp(campaign: Campaign, deps: CampaignDeps): void {
	campaign.updatedAt = iso(deps.now());
}

// --- rendering ---

function renderStatus(c: Campaign): string {
	const active = c.tasks.filter((t) => t.status === "running").length;
	const lines: string[] = [];
	lines.push(`campaign ${c.id}`);
	lines.push(`base ${c.baseBranch}@${c.baseSha.slice(0, 7)}`);
	lines.push(`status ${deriveCampaignStatus(c)}`);
	lines.push(`parallel ${active}/${c.maxParallel}`);
	for (const t of c.tasks) {
		lines.push("");
		const head = `${t.id.padEnd(10)} ${t.status.padEnd(13)}${t.branch ? ` branch ${t.branch}` : ""}`;
		lines.push(head);
		if (t.result) {
			const r = t.result;
			lines.push(
				`           ${r.loopStatus} · ${r.iterations} iter${r.finalVerdict ? ` · verdict ${r.finalVerdict}` : ""} · ${r.changedFiles.length} files`,
			);
		}
		if (t.dependencies.length > 0) {
			// v0 never assigns merge_ready/merged, so a pending dependent will not
			// auto-run. Say so plainly here, where the operator is looking.
			const inert = t.status === "pending" ? " (will not auto-run in v0; merge deps first)" : "";
			lines.push(`           waits on ${t.dependencies.join(", ")}${inert}`);
		}
		if (t.claimedPaths.length > 0) lines.push(`           paths ${t.claimedPaths.join(", ")}`);
		if (t.error) lines.push(`           error ${t.error}`);
	}
	return `${lines.join("\n")}\n`;
}

// Operational next-actions: this is the only place v0 talks about merging, and
// it only prints instructions — it never merges or pushes.
function renderNextActions(c: Campaign): string {
	const ready = c.tasks.filter((t) => t.status === "review_ready");
	const human = c.tasks.filter((t) => t.status === "needs_human");
	if (ready.length === 0 && human.length === 0) return "";
	const lines: string[] = ["", "Next actions (chit never merges or pushes for you):"];
	for (const t of ready) {
		lines.push(
			`  ${t.id}: review the diff on ${t.branch}, then merge into ${c.baseBranch} yourself.`,
		);
		if (t.worktreePath && t.branch) {
			lines.push(`    when done: ${cleanupInstructions(c.repo, t.worktreePath, t.branch)}`);
		}
	}
	for (const t of human) {
		lines.push(
			`  ${t.id}: needs manual classification — chit campaign start ... --claim ${t.id}=<paths>`,
		);
	}
	return `${lines.join("\n")}\n`;
}

// --- shared flag helpers ---

function req(p: Parsed, key: string, verb: string): string {
	const v = p.flags[key];
	if (v === undefined) throw new UsageError(`campaign ${verb} requires --${key}`);
	return v;
}

function reqPositional(p: Parsed, usage: string): string {
	if (p.positional === undefined) throw new UsageError(`campaign ${usage} requires a campaign id`);
	return p.positional;
}

export async function runCampaign(
	argv: string[],
	io: CampaignIO = defaultIO,
	deps: CampaignDeps = defaultDeps(),
): Promise<number> {
	const verb = argv[0];
	if (!verb || verb === "-h" || verb === "--help") {
		(verb ? io.out : io.err)(CAMPAIGN_HELP);
		return verb ? 0 : 2;
	}
	try {
		const p = parseFlags(verb, argv.slice(1));
		if (verb === "start") return await doStart(p, io, deps);
		if (verb === "status") return doStatus(p, io, deps);
		if (verb === "run") return await doRun(p, io, deps);
		if (verb === "inspect") return doInspect(p, io, deps);
		throw new UsageError(`unknown subcommand "${verb}" (use start|status|run|inspect)`);
	} catch (e) {
		if (e instanceof UsageError) {
			io.err(`chit campaign: ${e.message}\n\n${CAMPAIGN_HELP}`);
			return 2;
		}
		if (
			e instanceof CampaignError ||
			e instanceof CampaignStoreError ||
			e instanceof WorktreeError
		) {
			io.err(`chit campaign: ${e.message}\n`);
			return 1;
		}
		io.err(`chit campaign: ${(e as Error).message}\n`);
		return 1;
	}
}
