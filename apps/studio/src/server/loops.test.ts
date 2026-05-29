import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./index.ts";
import { listLoops, readLoop } from "./loops.ts";
import { generateToken } from "./token.ts";

const HOST = "127.0.0.1:4040";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "chit-studio-loops-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function loopsDir(): string {
	const dir = join(cwd, ".chit", "loops");
	mkdirSync(dir, { recursive: true });
	return dir;
}
function seed(loopId: string, lines: object[]) {
	writeFileSync(
		join(loopsDir(), `${loopId}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}
function seedRawFile(name: string, body: string) {
	writeFileSync(join(loopsDir(), name), body);
}

const header = (loopId: string, startedAt: string) => ({
	type: "loop",
	schema: 1,
	loopId,
	scope: "s",
	task: "t",
	repo: "/x",
	startedAt,
	maxIterations: 3,
});
const iter = (n: number) => ({
	type: "iteration",
	n,
	implementSummary: "x",
	changedFiles: ["a.ts"],
	checksRun: "t",
	verdict: "revise",
	findingCount: 1,
	decision: "revise",
	checkDurationMs: 1000,
	at: "2026-05-29T10:01:00.000Z",
});
const stopRec = (iterations: number) => ({
	type: "stop",
	status: "converged",
	reason: "done",
	iterations,
	totalElapsedMs: 5000,
	endedAt: "2026-05-29T10:03:00.000Z",
});

describe("studio loops loader: listLoops", () => {
	test("returns [] when .chit/loops is absent", () => {
		expect(listLoops(cwd)).toEqual([]);
	});

	test("summarizes loops newest-first, with status and totals", () => {
		seed("A", [header("A", "2026-05-29T10:00:00.000Z"), iter(1), stopRec(1)]);
		seed("B", [header("B", "2026-05-29T11:00:00.000Z"), iter(1)]); // in progress
		const out = listLoops(cwd);
		expect(out.map((s) => s.loopId)).toEqual(["B", "A"]); // newest startedAt first
		expect(out.find((s) => s.loopId === "A")).toMatchObject({
			status: "converged",
			iterations: 1,
			totalElapsedMs: 5000,
		});
		expect(out.find((s) => s.loopId === "B")).toMatchObject({
			status: "in-progress",
			iterations: 1,
			totalElapsedMs: null,
		});
	});

	test("skips a malformed file rather than failing the whole list", () => {
		seed("good", [header("good", "2026-05-29T10:00:00.000Z")]);
		seedRawFile("bad.jsonl", "not json\n");
		expect(listLoops(cwd).map((s) => s.loopId)).toEqual(["good"]);
	});

	test("never surfaces an unsafe or mismatched loopId (binds filename to header)", () => {
		// filename is safe, but the header claims an unsafe id -> skipped
		seed("safe", [header("../evil", "2026-05-29T10:00:00.000Z")]);
		// filename basename is itself an unsafe slug -> skipped
		seedRawFile("_bad.jsonl", `${JSON.stringify(header("_bad", "2026-05-29T10:00:00.000Z"))}\n`);
		expect(listLoops(cwd)).toEqual([]);
	});
});

describe("studio loops loader: readLoop", () => {
	test("ok returns the records in order", () => {
		seed("A", [header("A", "2026-05-29T10:00:00.000Z"), iter(1), stopRec(1)]);
		const r = readLoop(cwd, "A");
		expect(r.kind).toBe("ok");
		if (r.kind === "ok")
			expect(r.records.map((x) => x.type)).toEqual(["loop", "iteration", "stop"]);
	});

	test("not-found for an absent loop", () => {
		expect(readLoop(cwd, "nope").kind).toBe("not-found");
	});

	test("invalid-id for a traversal / unsafe id", () => {
		expect(readLoop(cwd, "../evil").kind).toBe("invalid-id");
		expect(readLoop(cwd, "_leading").kind).toBe("invalid-id");
	});

	test("invalid-log for a corrupt file", () => {
		seedRawFile("C.jsonl", "not json\n");
		expect(readLoop(cwd, "C").kind).toBe("invalid-log");
	});

	test("invalid-log when the header loopId disagrees with the file name", () => {
		seed("D", [header("OTHER", "2026-05-29T10:00:00.000Z")]);
		expect(readLoop(cwd, "D").kind).toBe("invalid-log");
	});
});

describe("studio loops routes", () => {
	function makeApp() {
		const token = generateToken();
		const app = buildApp({
			token,
			cwd,
			makeBootstrap: () => ({}) as never,
			store: {} as never,
			allowedHosts: new Set([HOST]),
			clientDistDir: "/nope",
		});
		return { app, token };
	}
	async function req(
		app: ReturnType<typeof buildApp>,
		path: string,
		token?: string,
	): Promise<Response> {
		const headers: Record<string, string> = { host: HOST };
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		return app.fetch(new Request(`http://${HOST}${path}`, { headers }));
	}

	test("GET /api/loops returns summaries (with auth)", async () => {
		seed("A", [header("A", "2026-05-29T10:00:00.000Z"), iter(1), stopRec(1)]);
		const { app, token } = makeApp();
		const res = await req(app, "/api/loops", token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ loopId: string; status: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({ loopId: "A", status: "converged" });
	});

	test("GET /api/loops/:id returns the records", async () => {
		seed("A", [header("A", "2026-05-29T10:00:00.000Z"), iter(1), stopRec(1)]);
		const { app, token } = makeApp();
		const res = await req(app, "/api/loops/A", token);
		expect(res.status).toBe(200);
		const recs = (await res.json()) as Array<{ type: string }>;
		expect(recs.map((x) => x.type)).toEqual(["loop", "iteration", "stop"]);
	});

	test("404 for a missing loop", async () => {
		const { app, token } = makeApp();
		expect((await req(app, "/api/loops/nope", token)).status).toBe(404);
	});

	test("400 for an unsafe loop id", async () => {
		const { app, token } = makeApp();
		expect((await req(app, "/api/loops/_bad", token)).status).toBe(400);
	});

	test("401 without the bearer token", async () => {
		const { app } = makeApp();
		expect((await req(app, "/api/loops")).status).toBe(401);
	});

	test("GET /api/loops omits a file whose header loopId is mismatched/unsafe", async () => {
		seed("safe", [header("../evil", "2026-05-29T10:00:00.000Z")]);
		const { app, token } = makeApp();
		const res = await req(app, "/api/loops", token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});
