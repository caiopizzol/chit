import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, PlanStoreError, plansDir } from "./store.ts";
import type { Plan } from "./types.ts";

let cwd: string;
let stateDir: string;
let savedXdg: string | undefined;
let store: PlanStore;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-plan-cwd-"));
	stateDir = mkdtempSync(join(tmpdir(), "chit-plan-state-"));
	savedXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateDir;
	store = new PlanStore(cwd);
});
afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
	rmSync(cwd, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function plan(id: string, over: Partial<Plan> = {}): Plan {
	return {
		schema: 1,
		id,
		repo: cwd,
		callerCheckout: cwd,
		repoKey: "k",
		title: "Add session auth",
		apply: "gated",
		cleanup: "after_apply",
		baseBranch: "main",
		baseSha: "abc123",
		integrationBranch: "chit/plan/add-auth",
		status: "running",
		steps: [{ id: "schema", title: "schema", body: "b", dependsOn: [], status: "pending" }],
		createdAt: "2026-06-01T10:00:00.000Z",
		updatedAt: "2026-06-01T10:00:00.000Z",
		...over,
	};
}

describe("PlanStore", () => {
	test("lives under the state dir keyed by repo, not in the repo", () => {
		expect(plansDir(cwd).startsWith(stateDir)).toBe(true);
		store.create(plan("p1"));
		expect(store.get("p1")).toMatchObject({ id: "p1", status: "running" });
	});

	test("create refuses to clobber an existing plan", () => {
		store.create(plan("p1"));
		expect(() => store.create(plan("p1"))).toThrow(/already exists/);
	});

	test("update is a read-modify-write", () => {
		store.create(plan("p1"));
		const next = store.update("p1", (p) => ({ ...p, status: "completed" }));
		expect(next.status).toBe("completed");
		expect(store.get("p1")?.status).toBe("completed");
	});

	test("update on a missing plan throws", () => {
		expect(() => store.update("ghost", (p) => p)).toThrow(/no plan/);
	});

	test("list is newest-first and skips corrupt files", () => {
		store.create(plan("old", { createdAt: "2026-06-01T10:00:00.000Z" }));
		store.create(plan("new", { createdAt: "2026-06-01T11:00:00.000Z" }));
		writeFileSync(join(plansDir(cwd), "broken.json"), "not json");
		expect(store.list().map((p) => p.id)).toEqual(["new", "old"]);
	});

	test("rejects an unsafe plan id", () => {
		expect(() => store.get("../evil")).toThrow(PlanStoreError);
	});

	test("the durable repo and the caller checkout both survive a round-trip and can differ", () => {
		// The linked-worktree lesson: `repo` is the durable main repo (the cleanup anchor),
		// `callerCheckout` is the launch checkout. They differ when a plan is launched from a
		// linked worktree, and both must survive the round-trip so cleanup anchors on the main
		// repo even after the launching checkout is removed.
		const mainRepo = join(cwd, "main");
		const linkedCheckout = join(cwd, "worktrees", "feature");
		store.create(plan("p1", { repo: mainRepo, callerCheckout: linkedCheckout }));
		const got = store.get("p1");
		expect(got?.repo).toBe(mainRepo);
		expect(got?.callerCheckout).toBe(linkedCheckout);
		expect(got?.repo).not.toBe(got?.callerCheckout);
	});

	test("the store namespace is keyed by the durable repo anchor, not callerCheckout", () => {
		const mainRepo = join(cwd, "main");
		const linkedCheckout = join(cwd, "worktrees", "feature");
		mkdirSync(mainRepo, { recursive: true });
		mkdirSync(linkedCheckout, { recursive: true });

		const mainStore = new PlanStore(mainRepo);
		const linkedStore = new PlanStore(linkedCheckout);
		mainStore.create(plan("p1", { repo: mainRepo, callerCheckout: linkedCheckout }));

		expect(mainStore.get("p1")?.callerCheckout).toBe(linkedCheckout);
		expect(linkedStore.get("p1")).toBeUndefined();
		expect(plansDir(mainRepo)).not.toBe(plansDir(linkedCheckout));
	});
});
