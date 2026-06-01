import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CampaignStoreError,
	campaignExists,
	campaignPath,
	createCampaign,
	readCampaign,
	validateCampaign,
	writeCampaign,
} from "./store.ts";
import type { Campaign, CampaignTask } from "./types.ts";

let repo: string;

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "chit-campaign-store-"));
});
afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

function task(id: string, over: Partial<CampaignTask> = {}): CampaignTask {
	return {
		id,
		title: `title ${id}`,
		body: "",
		status: "pending",
		dependencies: [],
		claimedPaths: [],
		...over,
	};
}

function campaign(over: Partial<Campaign> = {}): Campaign {
	return {
		schema: 1,
		id: "v0-mcp",
		repo,
		baseBranch: "main",
		baseSha: "abc123",
		maxParallel: 2,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		status: "planning",
		tasks: [task("issue-9"), task("issue-3")],
		...over,
	};
}

describe("createCampaign", () => {
	test("writes a campaign file under .chit/campaigns and it round-trips", () => {
		const { path } = createCampaign(campaign());
		expect(path).toBe(join(repo, ".chit", "campaigns", "v0-mcp.json"));
		expect(campaignExists(repo, "v0-mcp")).toBe(true);
		const read = readCampaign(repo, "v0-mcp");
		expect(read.tasks.map((t) => t.id)).toEqual(["issue-9", "issue-3"]);
		expect(read.baseSha).toBe("abc123");
	});

	test("refuses to overwrite an existing campaign", () => {
		createCampaign(campaign());
		expect(() => createCampaign(campaign())).toThrow(/already exists/);
	});

	test("refuses maxParallel above the v0 cap of 2", () => {
		expect(() => createCampaign(campaign({ maxParallel: 3 }))).toThrow(/exceeds the v0 cap/);
	});

	test("rejects an invalid campaign id (path traversal)", () => {
		expect(() => campaignPath(repo, "../evil")).toThrow(CampaignStoreError);
	});
});

describe("validateCampaign", () => {
	test("rejects a duplicate task id", () => {
		expect(() => validateCampaign(campaign({ tasks: [task("a"), task("a")] }))).toThrow(
			/duplicate task id/,
		);
	});

	test("rejects a dependency on an unknown task", () => {
		expect(() =>
			validateCampaign(campaign({ tasks: [task("a", { dependencies: ["ghost"] })] })),
		).toThrow(/depends on unknown task/);
	});

	test("rejects maxParallel above the cap (covers hand-edited/stale files)", () => {
		expect(() => validateCampaign(campaign({ maxParallel: 3 }))).toThrow(/between 1 and 2/);
	});

	test("readCampaign rejects a stored file whose maxParallel exceeds the cap", () => {
		createCampaign(campaign());
		writeFileSync(campaignPath(repo, "v0-mcp"), JSON.stringify({ ...campaign(), maxParallel: 5 }));
		expect(() => readCampaign(repo, "v0-mcp")).toThrow(/between 1 and 2/);
	});

	test("rejects an unknown task status", () => {
		const bad = campaign({ tasks: [task("a")] });
		// biome-ignore lint/suspicious/noExplicitAny: deliberately corrupting for the test
		(bad.tasks[0] as any).status = "bogus";
		expect(() => validateCampaign(bad)).toThrow(/must be one of/);
	});

	test("accepts a task carrying a full result", () => {
		const withResult = campaign({
			tasks: [
				task("a", {
					status: "review_ready",
					worktreePath: "/wt/a",
					branch: "b/a",
					loopId: "L1",
					result: {
						loopStatus: "converged",
						finalVerdict: "proceed",
						iterations: 2,
						changedFiles: ["src/x.ts"],
						auditRunIds: ["run-1"],
						summary: "did the thing",
					},
				}),
			],
		});
		expect(() => validateCampaign(withResult)).not.toThrow();
	});
});

describe("readCampaign", () => {
	test("throws a clean error for a missing campaign", () => {
		expect(() => readCampaign(repo, "nope")).toThrow(/no campaign/);
	});

	test("throws on corrupt JSON rather than a raw parse error", () => {
		createCampaign(campaign());
		writeFileSync(campaignPath(repo, "v0-mcp"), "{ not json");
		expect(() => readCampaign(repo, "v0-mcp")).toThrow(/invalid JSON/);
	});

	test("rejects a file whose declared id does not match its filename", () => {
		createCampaign(campaign());
		const mismatched = { ...campaign(), id: "other" };
		writeFileSync(campaignPath(repo, "v0-mcp"), JSON.stringify(mismatched));
		expect(() => readCampaign(repo, "v0-mcp")).toThrow(/declares id/);
	});
});

describe("writeCampaign (restart durability)", () => {
	test("a campaign written, then re-read in a fresh call, preserves task state", () => {
		createCampaign(campaign());
		// Simulate a run advancing one task, then a separate process reading it.
		const loaded = readCampaign(repo, "v0-mcp");
		const updated = loaded.tasks.find((t) => t.id === "issue-9");
		if (!updated) throw new Error("missing task");
		updated.status = "review_ready";
		updated.loopId = "L9";
		writeCampaign(loaded);

		const reread = readCampaign(repo, "v0-mcp");
		const t = reread.tasks.find((x) => x.id === "issue-9");
		expect(t?.status).toBe("review_ready");
		expect(t?.loopId).toBe("L9");
	});

	test("writes pretty JSON with a trailing newline", () => {
		createCampaign(campaign());
		const text = readFileSync(campaignPath(repo, "v0-mcp"), "utf-8");
		expect(text.endsWith("}\n")).toBe(true);
		expect(text).toContain("\n  "); // indented
	});
});
