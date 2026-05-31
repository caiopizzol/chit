import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditRun } from "./audit.ts";
import { buildApp } from "./index.ts";
import { generateToken } from "./token.ts";

const HOST = "127.0.0.1:4041";

let auditDir: string;
beforeEach(() => {
	auditDir = mkdtempSync(join(tmpdir(), "chit-studio-audit-"));
});
afterEach(() => {
	rmSync(auditDir, { recursive: true, force: true });
});

const INPUT_REF = "a".repeat(64);
const OUTPUT_REF = "b".repeat(64);
const RAW_REF = "c".repeat(64);

// Seed a run dir: events.jsonl + the two referenced blobs.
function seed(runId: string): void {
	const runDir = join(auditDir, "runs", runId);
	mkdirSync(join(runDir, "blobs"), { recursive: true });
	const events = [
		{
			type: "run.started",
			runId,
			ts: "2026-05-31T10:00:00.000Z",
			manifestId: "m",
			cwd: "/c",
			surface: "converge",
		},
		{
			type: "adapter.call.started",
			runId,
			ts: "2026-05-31T10:00:01.000Z",
			stepId: "a",
			participantId: "p",
			agentId: "ag",
			cwd: "/c",
			inputBlob: INPUT_REF,
		},
		{
			type: "adapter.event",
			runId,
			ts: "2026-05-31T10:00:05.000Z",
			stepId: "a",
			eventType: "item.completed",
			rawBlob: RAW_REF,
		},
		{
			type: "adapter.call.completed",
			runId,
			ts: "2026-05-31T10:00:10.000Z",
			stepId: "a",
			outputBlob: OUTPUT_REF,
			durationMs: 100,
			status: "ok",
			usage: { inputTokens: 10, outputTokens: 2 },
		},
		{
			type: "run.completed",
			runId,
			ts: "2026-05-31T10:00:12.000Z",
			status: "ok",
			durationMs: 2000,
		},
	];
	writeFileSync(
		join(runDir, "events.jsonl"),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	writeFileSync(join(runDir, "blobs", INPUT_REF), "THE PROMPT");
	writeFileSync(join(runDir, "blobs", OUTPUT_REF), "THE OUTPUT");
	writeFileSync(join(runDir, "blobs", RAW_REF), "THE RAW CODEX EVENT");
}

describe("studio audit loader: readAuditRun", () => {
	test("reads events for a run; resolves blobs only when asked", () => {
		seed("R1");
		const noBlobs = readAuditRun(auditDir, "R1", false);
		expect(noBlobs.kind).toBe("ok");
		if (noBlobs.kind === "ok") {
			expect(noBlobs.events.map((e) => e.type)).toEqual([
				"run.started",
				"adapter.call.started",
				"adapter.event",
				"adapter.call.completed",
				"run.completed",
			]);
			expect(noBlobs.blobs).toBeUndefined();
		}
		const withBlobs = readAuditRun(auditDir, "R1", true);
		if (withBlobs.kind === "ok") {
			expect(withBlobs.blobs?.[INPUT_REF]).toBe("THE PROMPT");
			expect(withBlobs.blobs?.[OUTPUT_REF]).toBe("THE OUTPUT");
			expect(withBlobs.blobs?.[RAW_REF]).toBe("THE RAW CODEX EVENT"); // adapter.event raw resolves
		}
	});

	test("distinguishes not-found and invalid-id", () => {
		expect(readAuditRun(auditDir, "ghost", false).kind).toBe("not-found");
		expect(readAuditRun(auditDir, "../evil", false).kind).toBe("invalid-id");
	});

	test("reports invalid-log for a corrupt events file", () => {
		const runDir = join(auditDir, "runs", "BAD");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "events.jsonl"), "not json\n");
		expect(readAuditRun(auditDir, "BAD", false).kind).toBe("invalid-log");
	});
});

describe("studio audit route", () => {
	function makeApp() {
		const token = generateToken();
		const app = buildApp({
			token,
			cwd: "/nope",
			makeBootstrap: () => ({}) as never,
			store: {} as never,
			allowedHosts: new Set([HOST]),
			clientDistDir: "/nope",
			auditDir,
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

	test("GET /api/audit/:runId returns events (no blobs by default)", async () => {
		seed("R1");
		const { app, token } = makeApp();
		const res = await req(app, "/api/audit/R1", token);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: { type: string }[]; blobs?: unknown };
		expect(body.events[0]?.type).toBe("run.started");
		expect(body.blobs).toBeUndefined();
	});

	test("?blobs=1 also returns the referenced bodies", async () => {
		seed("R1");
		const { app, token } = makeApp();
		const res = await req(app, "/api/audit/R1?blobs=1", token);
		const body = (await res.json()) as { blobs: Record<string, string> };
		expect(body.blobs[INPUT_REF]).toBe("THE PROMPT");
		expect(body.blobs[OUTPUT_REF]).toBe("THE OUTPUT");
	});

	test("404 for a missing run, 400 for an unsafe id, 401 without a token", async () => {
		const { app, token } = makeApp();
		expect((await req(app, "/api/audit/ghost", token)).status).toBe(404);
		expect((await req(app, "/api/audit/_bad", token)).status).toBe(400);
		expect((await req(app, "/api/audit/R1")).status).toBe(401);
	});
});
