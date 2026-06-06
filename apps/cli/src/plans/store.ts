// Durable store for plans: one JSON file per plan under the state dir, keyed by the
// durable main repo anchor, written atomically (temp + rename) under a per-file O_EXCL
// lock. Mirrors BatchStore exactly (same lock primitive from jobs/lock.ts), so a future
// chit_plan_advance updating step state never races a concurrent reader. Plan state lives
// OUTSIDE the reviewed tree (state dir, not .chit/), per the control-plane rule, and is
// the source of truth for closed-session recovery (chit_plan_list recovers a lost
// plan_id).

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../jobs/lock.ts";
import { repoKey } from "../loops/location.ts";
import type { Plan } from "./types.ts";

export class PlanStoreError extends Error {}

// A plan id becomes a filename, so constrain it: no separators, traversal, dotfiles. Looser
// than the parse-time kebab-case plan-id slug because a generated uuid may lead with a digit;
// identical to BatchStore's guard.
const SAFE_PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Plans live under <state>/chit/plans/<repoKey>/<id>.json. Callers should pass the
// durable main repo anchor here, not a linked launching checkout, so a removed launch
// worktree cannot strand the plan record.
export function plansDir(repoAnchor: string): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "plans", repoKey(repoAnchor));
}

export class PlanStore {
	// `repoAnchor` is the durable main repo that owns the shared .git. The plan record
	// separately stores callerCheckout for apply defaults.
	constructor(private readonly repoAnchor: string) {}

	private dir(): string {
		return plansDir(this.repoAnchor);
	}

	private path(id: string): string {
		if (!SAFE_PLAN_ID.test(id)) {
			throw new PlanStoreError(`invalid plan id ${JSON.stringify(id)}`);
		}
		return join(this.dir(), `${id}.json`);
	}

	private lockPath(id: string): string {
		return `${this.path(id)}.lock`;
	}

	create(plan: Plan): void {
		mkdirSync(this.dir(), { recursive: true });
		const path = this.path(plan.id);
		withFileLock(this.lockPath(plan.id), () => {
			if (existsSync(path)) {
				throw new PlanStoreError(`plan ${JSON.stringify(plan.id)} already exists`);
			}
			writeAtomic(path, plan);
		});
	}

	get(id: string): Plan | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as Plan;
		} catch {
			return undefined;
		}
	}

	// Read-modify-write under the lock. `mutate` returns the next plan; the write is atomic.
	// Throws if the plan is missing.
	update(id: string, mutate: (current: Plan) => Plan): Plan {
		const path = this.path(id);
		// Ensure the dir exists so the lock file can be created even when updating a plan that
		// was never created (we then throw the clean not-found below).
		mkdirSync(this.dir(), { recursive: true });
		return withFileLock(this.lockPath(id), () => {
			if (!existsSync(path)) throw new PlanStoreError(`no plan ${JSON.stringify(id)}`);
			const current = JSON.parse(readFileSync(path, "utf-8")) as Plan;
			const next = mutate(current);
			writeAtomic(path, next);
			return next;
		});
	}

	// All plans for this repo, newest-created first; skips corrupt files.
	list(): Plan[] {
		const dir = this.dir();
		if (!existsSync(dir)) return [];
		const out: Plan[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as Plan);
			} catch {
				// skip corrupt/mid-write file
			}
		}
		out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return out;
	}
}

function writeAtomic(path: string, plan: Plan): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(plan, null, 2));
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
