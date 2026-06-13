import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Adapter, fakeAdapter } from "./adapter.ts";
import { type CliDeps, runCli } from "./cli.ts";

let dir: string;

const GRILLER = {
	id: "feature-griller",
	policy: "one-shot",
	description: "Question a feature idea.",
	inputs: { idea: { type: "string" }, context: { type: "string", required: false } },
	participants: { griller: { agent: "claude", instructions: "Read-only.", filesystem: "read-only" } },
	steps: [
		{ id: "grill", call: "griller", prompt: "Idea: {{ inputs.idea }}" },
		{ id: "out", format: "{{ steps.grill.output }}" },
	],
	output: "out",
};

const REVIEW = {
	id: "impl-review",
	policy: "converge",
	inputs: { task: { type: "string" } },
	participants: {
		builder: { agent: "codex", instructions: "Implement.", filesystem: "read-write" },
		critic: { agent: "claude", instructions: "Review.", filesystem: "read-only" },
	},
	steps: [
		{ id: "build", call: "builder", prompt: "{{ inputs.task }}" },
		{ id: "critique", call: "critic", prompt: "{{ steps.build.output }}" },
		{ id: "verify", check: [{ command: "bun", args: ["test"] }] },
	],
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "chit-min-cli-"));
	mkdirSync(join(dir, "examples"), { recursive: true });
	writeFileSync(join(dir, "examples", "feature-griller.json"), JSON.stringify(GRILLER));
	writeFileSync(join(dir, "examples", "impl-review.json"), JSON.stringify(REVIEW));
	writeFileSync(
		join(dir, "chit.config.json"),
		JSON.stringify({
			routines: {
				"feature-griller": { manifestPath: "examples/feature-griller.json", description: "Question a feature idea." },
				"impl-review": { manifestPath: "examples/impl-review.json", description: "Implement and review." },
			},
		}),
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(adapter: Adapter = fakeAdapter()) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: CliDeps = {
		cwd: dir,
		adapter,
		now: () => 0,
		newRunId: () => "run-test",
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	};
	return { deps, out, err };
}

describe("chit routines", () => {
	test("lists both routines with their policies", async () => {
		const { deps, out } = harness();
		expect(await runCli(["routines"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("feature-griller");
		expect(text).toContain("one-shot");
		expect(text).toContain("impl-review");
		expect(text).toContain("converge");
	});
});

describe("chit inspect", () => {
	test("inspects a one-shot routine", async () => {
		const { deps, out } = harness();
		expect(await runCli(["inspect", "feature-griller"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("feature-griller  (one-shot)");
		expect(text).toContain("idea");
		expect(text).toContain("call griller");
	});

	test("inspects a converge routine as ordered steps and notes execution is gated", async () => {
		const { deps, out } = harness();
		expect(await runCli(["inspect", "impl-review"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("call builder");
		expect(text).toContain("check: bun test");
		expect(text).toMatch(/working step-based executor/);
	});

	test("refuses an unknown routine with a helpful error", async () => {
		const { deps, err } = harness();
		expect(await runCli(["inspect", "ghost"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/unknown routine "ghost"/);
	});
});

describe("chit run", () => {
	test("runs a one-shot routine and prints output plus a run id", async () => {
		const { deps, out } = harness(fakeAdapter((req) => `GRILLED:${req.prompt}`));
		expect(await runCli(["run", "feature-griller", "--input", "idea=dark mode"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("GRILLED:Idea: dark mode");
		expect(text).toContain("run run-test");
	});

	test("refuses a missing required input", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "feature-griller"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/missing required input "idea"/);
	});

	test("refuses to live-run a converge routine (gated on write-safety)", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "impl-review", "--input", "task=x"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/gated until the write-safety slice/);
	});

	test("rejects a malformed --input", async () => {
		const { deps, err } = harness();
		expect(await runCli(["run", "feature-griller", "--input", "idea"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/--input expects/);
	});
});

describe("chit trace", () => {
	test("traces a run after it has executed", async () => {
		const run = harness(fakeAdapter(() => "report body"));
		await runCli(["run", "feature-griller", "--input", "idea=x"], run.deps);

		const { deps, out } = harness();
		expect(await runCli(["trace", "run-test"], deps)).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("run-test  feature-griller  completed");
		expect(text).toContain("call griller");
		expect(text).not.toContain("report body"); // receipt summarizes, no transcript body
	});

	test("refuses an unknown run id", async () => {
		const { deps, err } = harness();
		expect(await runCli(["trace", "nope"], deps)).toBe(1);
		expect(err.join("\n")).toMatch(/no run "nope" found/);
	});
});

describe("chit help", () => {
	test("prints usage with no args", async () => {
		const { deps, out } = harness();
		expect(await runCli([], deps)).toBe(0);
		expect(out.join("\n")).toMatch(/chit routines/);
	});
});
