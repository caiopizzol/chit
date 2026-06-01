// Node-backed store for campaign records: one JSON file per campaign under
// <repo>/.chit/campaigns/<id>.json. The model + validation live here too (this
// is cli-only; see types.ts). Reads validate the whole file so a corrupt or
// hand-edited record fails loudly instead of being half-trusted.
//
// Concurrency: SINGLE-WRITER, like the loop-log store. One `chit campaign run`
// drives a campaign at a time. Writes are atomic (temp file + rename) so a
// reader never sees a partial file and an interrupted write leaves at most a
// stray .tmp, but two concurrent writers to the same campaign could lose each
// other's update. v0 does not run them concurrently.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Campaign,
	type CampaignStatus,
	type CampaignTask,
	MAX_PARALLEL_CAP,
	type TaskResult,
	type TaskStatus,
} from "./types.ts";

export class CampaignStoreError extends Error {}

// A campaign id becomes a filename under .chit/campaigns/, so constrain it: no
// path separators, no traversal, no dotfiles. Same shape as a loop id.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const CAMPAIGN_STATUSES: ReadonlySet<string> = new Set([
	"planning",
	"running",
	"needs_human",
	"ready_for_review",
	"complete",
	"failed",
]);

const TASK_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"blocked",
	"review_ready",
	"merge_ready",
	"merged",
	"failed",
	"needs_human",
]);

const LOOP_STATUSES: ReadonlySet<string> = new Set(["converged", "blocked", "max-iterations"]);
const VERDICTS: ReadonlySet<string> = new Set(["proceed", "revise", "block"]);

function campaignsDir(repo: string): string {
	return join(repo, ".chit", "campaigns");
}

export function campaignPath(repo: string, id: string): string {
	if (!SAFE_ID.test(id)) {
		throw new CampaignStoreError(`invalid campaign id ${JSON.stringify(id)}`);
	}
	return join(campaignsDir(repo), `${id}.json`);
}

// --- validation ---

function obj(raw: unknown, ctx: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new CampaignStoreError(`${ctx}: expected a JSON object`);
	}
	return raw as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, ctx: string): string {
	const v = o[key];
	if (typeof v !== "string" || v === "") {
		throw new CampaignStoreError(`${ctx}: "${key}" must be a non-empty string`);
	}
	return v;
}

// A string that is allowed to be empty (e.g. a task body or summary).
function strAllowEmpty(o: Record<string, unknown>, key: string, ctx: string): string {
	const v = o[key];
	if (typeof v !== "string") {
		throw new CampaignStoreError(`${ctx}: "${key}" must be a string`);
	}
	return v;
}

function int(o: Record<string, unknown>, key: string, ctx: string, min: number): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
		throw new CampaignStoreError(`${ctx}: "${key}" must be an integer >= ${min}`);
	}
	return v;
}

function stringArray(o: Record<string, unknown>, key: string, ctx: string): string[] {
	const v = o[key];
	if (!Array.isArray(v) || v.some((e) => typeof e !== "string" || e === "")) {
		throw new CampaignStoreError(`${ctx}: "${key}" must be an array of non-empty strings`);
	}
	return v as string[];
}

function oneOf(value: string, allowed: ReadonlySet<string>, key: string, ctx: string): string {
	if (!allowed.has(value)) {
		throw new CampaignStoreError(`${ctx}: "${key}" must be one of ${[...allowed].join(", ")}`);
	}
	return value;
}

function validateResult(raw: unknown, ctx: string): TaskResult {
	const o = obj(raw, ctx);
	const result: TaskResult = {
		loopStatus: oneOf(str(o, "loopStatus", ctx), LOOP_STATUSES, "loopStatus", ctx) as
			| "converged"
			| "blocked"
			| "max-iterations",
		iterations: int(o, "iterations", ctx, 0),
		changedFiles: stringArray(o, "changedFiles", ctx),
		auditRunIds: stringArray(o, "auditRunIds", ctx),
		summary: strAllowEmpty(o, "summary", ctx),
	};
	if (o.finalVerdict !== undefined) {
		result.finalVerdict = oneOf(
			str(o, "finalVerdict", ctx),
			VERDICTS,
			"finalVerdict",
			ctx,
		) as TaskResult["finalVerdict"];
	}
	return result;
}

function validateTask(raw: unknown, ctx: string): CampaignTask {
	const o = obj(raw, ctx);
	const task: CampaignTask = {
		id: str(o, "id", ctx),
		title: strAllowEmpty(o, "title", ctx),
		body: strAllowEmpty(o, "body", ctx),
		status: oneOf(str(o, "status", ctx), TASK_STATUSES, "status", ctx) as TaskStatus,
		dependencies: stringArray(o, "dependencies", ctx),
		claimedPaths: stringArray(o, "claimedPaths", ctx),
	};
	if (o.issueNumber !== undefined) task.issueNumber = int(o, "issueNumber", ctx, 1);
	if (o.worktreePath !== undefined) task.worktreePath = str(o, "worktreePath", ctx);
	if (o.branch !== undefined) task.branch = str(o, "branch", ctx);
	if (o.loopId !== undefined) task.loopId = str(o, "loopId", ctx);
	if (o.error !== undefined) task.error = str(o, "error", ctx);
	if (o.result !== undefined) task.result = validateResult(o.result, `${ctx}.result`);
	return task;
}

export function validateCampaign(raw: unknown): Campaign {
	const o = obj(raw, "campaign");
	if (o.schema !== 1) throw new CampaignStoreError(`campaign: "schema" must be 1`);
	const tasksRaw = o.tasks;
	if (!Array.isArray(tasksRaw)) {
		throw new CampaignStoreError(`campaign: "tasks" must be an array`);
	}
	const tasks = tasksRaw.map((t, i) => validateTask(t, `task[${i}]`));
	const ids = new Set<string>();
	for (const t of tasks) {
		if (ids.has(t.id))
			throw new CampaignStoreError(`campaign: duplicate task id ${JSON.stringify(t.id)}`);
		ids.add(t.id);
	}
	// Dependencies must reference real tasks in this campaign.
	for (const t of tasks) {
		for (const dep of t.dependencies) {
			if (!ids.has(dep)) {
				throw new CampaignStoreError(
					`campaign: task ${JSON.stringify(t.id)} depends on unknown task ${JSON.stringify(dep)}`,
				);
			}
		}
	}
	return {
		schema: 1,
		id: str(o, "id", "campaign"),
		repo: str(o, "repo", "campaign"),
		baseBranch: str(o, "baseBranch", "campaign"),
		baseSha: str(o, "baseSha", "campaign"),
		maxParallel: int(o, "maxParallel", "campaign", 1),
		createdAt: str(o, "createdAt", "campaign"),
		updatedAt: str(o, "updatedAt", "campaign"),
		status: oneOf(
			str(o, "status", "campaign"),
			CAMPAIGN_STATUSES,
			"status",
			"campaign",
		) as CampaignStatus,
		tasks,
	};
}

// --- filesystem ---

export function campaignExists(repo: string, id: string): boolean {
	return existsSync(campaignPath(repo, id));
}

export function readCampaign(repo: string, id: string): Campaign {
	const path = campaignPath(repo, id);
	if (!existsSync(path)) {
		throw new CampaignStoreError(`no campaign ${JSON.stringify(id)} at ${path}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new CampaignStoreError(
			`campaign ${JSON.stringify(id)} at ${path}: invalid JSON: ${(e as Error).message}`,
		);
	}
	const campaign = validateCampaign(raw);
	if (campaign.id !== id) {
		throw new CampaignStoreError(
			`campaign file at ${path} declares id ${JSON.stringify(campaign.id)}, expected ${JSON.stringify(id)}`,
		);
	}
	return campaign;
}

// Create a fresh campaign file. Refuses to overwrite an existing one. Validates
// (including the parallel cap) before writing.
export function createCampaign(campaign: Campaign): { path: string } {
	if (campaign.maxParallel > MAX_PARALLEL_CAP) {
		throw new CampaignStoreError(
			`maxParallel ${campaign.maxParallel} exceeds the v0 cap of ${MAX_PARALLEL_CAP}`,
		);
	}
	const valid = validateCampaign(campaign);
	const path = campaignPath(valid.repo, valid.id);
	if (existsSync(path)) {
		throw new CampaignStoreError(`campaign ${JSON.stringify(valid.id)} already exists at ${path}`);
	}
	mkdirSync(campaignsDir(valid.repo), { recursive: true });
	atomicWrite(path, valid);
	return { path };
}

// Overwrite an existing campaign (the run/update path). Validates first, then
// writes atomically. The caller stamps updatedAt.
export function writeCampaign(campaign: Campaign): { path: string } {
	const valid = validateCampaign(campaign);
	const path = campaignPath(valid.repo, valid.id);
	mkdirSync(campaignsDir(valid.repo), { recursive: true });
	atomicWrite(path, valid);
	return { path };
}

function atomicWrite(path: string, campaign: Campaign): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(campaign, null, 2)}\n`);
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
