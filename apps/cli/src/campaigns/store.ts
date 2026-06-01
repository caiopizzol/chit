// Durable store for campaigns: one JSON file per campaign under the state dir,
// keyed by repo, written atomically (temp + rename) under a per-file O_EXCL lock.
// Mirrors the JobStore exactly (same lock primitive from jobs/lock.ts), so a
// chit_campaign_advance updating task state never races a concurrent reader.
// Campaign state lives OUTSIDE the reviewed tree (state dir, not .chit/), per the
// control-plane rule.

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
import type { Campaign } from "./types.ts";

export class CampaignStoreError extends Error {}

const SAFE_CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Campaigns live under <state>/chit/campaigns/<repoKey>/<id>.json, keyed by the
// same repo hash the loop logs use, so one repo's campaigns are namespaced apart.
export function campaignsDir(cwd: string): string {
	const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(xdg, "chit", "campaigns", repoKey(cwd));
}

export class CampaignStore {
	// `cwd` is any path inside the target repo; repoKey resolves it to the repo
	// namespace (so a campaign started from a subdir lands in the same place).
	constructor(private readonly cwd: string) {}

	private dir(): string {
		return campaignsDir(this.cwd);
	}

	private path(id: string): string {
		if (!SAFE_CAMPAIGN_ID.test(id)) {
			throw new CampaignStoreError(`invalid campaign id ${JSON.stringify(id)}`);
		}
		return join(this.dir(), `${id}.json`);
	}

	private lockPath(id: string): string {
		return `${this.path(id)}.lock`;
	}

	create(campaign: Campaign): void {
		mkdirSync(this.dir(), { recursive: true });
		const path = this.path(campaign.id);
		withFileLock(this.lockPath(campaign.id), () => {
			if (existsSync(path)) {
				throw new CampaignStoreError(`campaign ${JSON.stringify(campaign.id)} already exists`);
			}
			writeAtomic(path, campaign);
		});
	}

	get(id: string): Campaign | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as Campaign;
		} catch {
			return undefined;
		}
	}

	// Read-modify-write under the lock. `mutate` returns the next campaign; the
	// write is atomic. Throws if the campaign is missing.
	update(id: string, mutate: (current: Campaign) => Campaign): Campaign {
		const path = this.path(id);
		// Ensure the dir exists so the lock file can be created even when updating a
		// campaign that was never created (we then throw the clean not-found below).
		mkdirSync(this.dir(), { recursive: true });
		return withFileLock(this.lockPath(id), () => {
			if (!existsSync(path)) throw new CampaignStoreError(`no campaign ${JSON.stringify(id)}`);
			const current = JSON.parse(readFileSync(path, "utf-8")) as Campaign;
			const next = mutate(current);
			writeAtomic(path, next);
			return next;
		});
	}

	// All campaigns for this repo, newest-created first; skips corrupt files.
	list(): Campaign[] {
		const dir = this.dir();
		if (!existsSync(dir)) return [];
		const out: Campaign[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(dir, name), "utf-8")) as Campaign);
			} catch {
				// skip corrupt/mid-write file
			}
		}
		out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return out;
	}
}

function writeAtomic(path: string, campaign: Campaign): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(campaign, null, 2));
	try {
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}
