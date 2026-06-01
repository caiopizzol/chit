import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignStore, CampaignStoreError, campaignsDir } from "./store.ts";
import type { Campaign } from "./types.ts";

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: CampaignStore;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-camp-cwd-"));
	stateDir = mkdtempSync(join(tmpdir(), "chit-camp-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new CampaignStore(cwd);
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function campaign(id: string, over: Partial<Campaign> = {}): Campaign {
	return {
		schema: 1,
		id,
		repo: cwd,
		repoKey: "k",
		baseBranch: "main",
		baseSha: "abc123",
		maxParallel: 2,
		status: "running",
		tasks: [],
		createdAt: "2026-06-01T10:00:00.000Z",
		updatedAt: "2026-06-01T10:00:00.000Z",
		...over,
	};
}

describe("CampaignStore", () => {
	test("lives under the state dir keyed by repo, not in the repo", () => {
		expect(campaignsDir(cwd).startsWith(stateDir)).toBe(true);
		store.create(campaign("c1"));
		expect(store.get("c1")).toMatchObject({ id: "c1", status: "running" });
	});

	test("create refuses to clobber an existing campaign", () => {
		store.create(campaign("c1"));
		expect(() => store.create(campaign("c1"))).toThrow(/already exists/);
	});

	test("update is a read-modify-write", () => {
		store.create(campaign("c1"));
		const next = store.update("c1", (c) => ({ ...c, status: "ready_for_review" }));
		expect(next.status).toBe("ready_for_review");
		expect(store.get("c1")?.status).toBe("ready_for_review");
	});

	test("update on a missing campaign throws", () => {
		expect(() => store.update("ghost", (c) => c)).toThrow(/no campaign/);
	});

	test("list is newest-first and skips corrupt files", () => {
		store.create(campaign("old", { createdAt: "2026-06-01T10:00:00.000Z" }));
		store.create(campaign("new", { createdAt: "2026-06-01T11:00:00.000Z" }));
		writeFileSync(join(campaignsDir(cwd), "broken.json"), "not json");
		expect(store.list().map((c) => c.id)).toEqual(["new", "old"]);
	});

	test("rejects an unsafe campaign id", () => {
		expect(() => store.get("../evil")).toThrow(CampaignStoreError);
	});
});
