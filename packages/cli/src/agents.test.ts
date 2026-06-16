// Configurable agents: a routine agent references a profile id; the config binds
// that profile to an actual adapter + model.
// These are always-on (fake-backed) so they prove the binding model with no real calls.

import { describe, expect, test } from "bun:test";
import { type Adapter, claudeCliArgs, codexCliArgs, dispatchingAdapter, fakeAdapter } from "./adapter.ts";
import { fakeCheckRunner } from "./check-runner.ts";
import { type ChitConfig, parseConfig } from "./config.ts";
import { runConverge } from "./converge.ts";
import { resolveFlow, runFlow } from "./flow.ts";
import { resolveRoutine } from "./routine.ts";
import { fakeSandboxFactory } from "./sandbox.ts";

const baseReq = (agent: string) => ({ agent, instructions: "i", prompt: "p", filesystem: "none" as const, cwd: "/x" });

describe("dispatchingAdapter", () => {
	test("routes each call to its configured adapter and passes profile settings through", async () => {
		const claude = fakeAdapter((r) => `claude:${r.model ?? "-"}`);
		const codex = fakeAdapter((r) => `codex:${r.model ?? "-"}`);
		const a = dispatchingAdapter(
			{
				builder: { adapter: "codex", model: "gpt-5.5", effort: "xhigh" },
				critic: { adapter: "claude", effort: "max" },
			},
			{ claude, codex },
		);
		expect((await a.call(baseReq("builder"))).output).toBe("codex:gpt-5.5");
		expect((await a.call(baseReq("critic"))).output).toBe("claude:-");
		expect(codex.calls[0]?.model).toBe("gpt-5.5"); // the resolved model reached the adapter
		expect(codex.calls[0]?.effort).toBe("xhigh");
		expect(claude.calls[0]?.model).toBeUndefined();
		expect(claude.calls[0]?.effort).toBe("max");
	});

	test("fails cleanly on an unknown profile id", async () => {
		const a = dispatchingAdapter({}, { claude: fakeAdapter() });
		await expect(a.call(baseReq("ghost"))).rejects.toThrow(/no profile "ghost" is configured/);
	});

	test("fails cleanly on an adapter type that is not wired", async () => {
		const a = dispatchingAdapter({ x: { adapter: "openai" } }, { claude: fakeAdapter() });
		await expect(a.call(baseReq("x"))).rejects.toThrow(/uses adapter "openai", which is not available/);
	});
});

describe("real adapter argument builders", () => {
	test("passes claude effort before variadic tool permission args", () => {
		expect(claudeCliArgs({ filesystem: "read-only", model: "claude-opus-4-8", effort: "max" })).toEqual([
			"claude",
			"-p",
			"--model",
			"claude-opus-4-8",
			"--effort",
			"max",
			"--permission-mode",
			"default",
			"--disallowedTools",
			"Edit",
			"Write",
			"NotebookEdit",
			"Bash",
		]);
	});

	test("passes codex effort as the Codex reasoning config override", () => {
		expect(codexCliArgs({ filesystem: "read-write", model: "gpt-5.5", effort: "xhigh" }, "/tmp/last.txt")).toEqual([
			"codex",
			"exec",
			"--sandbox",
			"workspace-write",
			"--skip-git-repo-check",
			"--ephemeral",
			"--model",
			"gpt-5.5",
			"-c",
			'model_reasoning_effort="xhigh"',
			"-o",
			"/tmp/last.txt",
			"-",
		]);
	});
});

describe("agent binding at resolve time", () => {
	const MANIFEST = JSON.stringify({
		id: "r",
		inputs: { task: { type: "string" } },
		agents: {
			b: { profile: "builder", instructions: "build", filesystem: "read-write" },
			c: { profile: "critic", instructions: "review", filesystem: "read-only" },
		},
		steps: [
			{ id: "build", call: "b", prompt: "{{ inputs.task }}" },
			{ id: "crit", call: "c", prompt: "{{ steps.build.output }}" },
			{ id: "verify", check: [{ command: "true", args: [] }] },
		],
		repeat: { until: "checks-pass", maxIterations: 1 },
	});
	const cfg = (profiles: unknown): ChitConfig =>
		parseConfig({ routines: { r: { file: "r.json" } }, profiles }, "t.json");

	test("binds each routine agent's profile id to its config entry", () => {
		const r = resolveRoutine(
			cfg({ builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude" } }),
			"r",
			"/x",
			() => MANIFEST,
		);
		expect(r.agents).toEqual({ builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude" } });
	});

	test("a routine agent referencing an undefined profile fails at resolve, not mid-run", () => {
		expect(() => resolveRoutine(cfg({ builder: { adapter: "claude" } }), "r", "/x", () => MANIFEST)).toThrow(
			/uses profile "critic", which is not defined/,
		);
	});

	test("different routine agents drive different configured adapters end to end", async () => {
		const routine = resolveRoutine(
			cfg({ builder: { adapter: "codex" }, critic: { adapter: "claude" } }),
			"r",
			"/x",
			() => MANIFEST,
		);
		const claude = fakeAdapter(() => "reviewed");
		const codex = fakeAdapter(() => "built");
		const adapter = dispatchingAdapter(routine.agents ?? {}, { claude, codex });
		let t = 0;
		const r = await runConverge(
			routine,
			{ task: "x" },
			{ adapter, checkRunner: fakeCheckRunner(), cwd: "/x", now: () => ++t, newRunId: () => "run" },
		);
		expect(r.status).toBe("converged");
		expect(codex.calls.map((c) => c.agent)).toEqual(["builder"]); // builder -> codex
		expect(claude.calls.map((c) => c.agent)).toEqual(["critic"]); // critic -> claude
		// the receipt records the RESOLVED binding per call step (audit: what actually ran)
		const steps = r.iterations[0]?.steps ?? [];
		expect(steps.find((s) => s.id === "build")).toMatchObject({ agent: "builder", adapter: "codex" });
		expect(steps.find((s) => s.id === "crit")).toMatchObject({ agent: "critic", adapter: "claude" });
	});

	test("a FAILED call step still records the agent + binding (audit consistency)", async () => {
		const routine = resolveRoutine(
			cfg({ builder: { adapter: "codex" }, critic: { adapter: "claude" } }),
			"r",
			"/x",
			() => MANIFEST,
		);
		const claude = fakeAdapter(() => "x");
		const codex: Adapter = {
			async call() {
				throw new Error("boom");
			},
		};
		const adapter = dispatchingAdapter(routine.agents ?? {}, { claude, codex });
		let t = 0;
		const r = await runConverge(
			routine,
			{ task: "x" },
			{ adapter, checkRunner: fakeCheckRunner(), cwd: "/x", now: () => ++t, newRunId: () => "run" },
		);
		expect(r.status).toBe("failed");
		// the failed build step records which profile/adapter it ran on, not just the routine agent
		expect(r.iterations[0]?.steps.find((s) => s.id === "build")).toMatchObject({
			status: "failed",
			agent: "builder",
			adapter: "codex",
		});
	});

	test("multi-model: two profiles on the SAME adapter select different models per step", async () => {
		const routine = resolveRoutine(
			cfg({ builder: { adapter: "claude", model: "sonnet" }, critic: { adapter: "claude", model: "haiku" } }),
			"r",
			"/x",
			() => MANIFEST,
		);
		const claude = fakeAdapter(() => "ok");
		const adapter = dispatchingAdapter(routine.agents ?? {}, { claude });
		let t = 0;
		const r = await runConverge(
			routine,
			{ task: "x" },
			{ adapter, checkRunner: fakeCheckRunner(), cwd: "/x", now: () => ++t, newRunId: () => "run" },
		);
		// the adapter saw each routine agent's configured model
		expect(Object.fromEntries(claude.calls.map((c) => [c.agent, c.model]))).toEqual({
			builder: "sonnet",
			critic: "haiku",
		});
		// and the receipt records the resolved model per call step
		const steps = r.iterations[0]?.steps ?? [];
		expect(steps.find((s) => s.id === "build")).toMatchObject({ adapter: "claude", model: "sonnet" });
		expect(steps.find((s) => s.id === "crit")).toMatchObject({ adapter: "claude", model: "haiku" });
	});
});

describe("composition across differently configured agents", () => {
	test("a flow passes output across sub-routines backed by different agents", async () => {
		const config = parseConfig(
			{
				routines: { a: { file: "a.json" }, b: { file: "b.json" }, flow: { file: "flow.json" } },
				profiles: { alpha: { adapter: "ad1" }, beta: { adapter: "ad2" } },
			},
			"t.json",
		);
		const manifests: Record<string, string> = {
			"a.json": JSON.stringify({
				id: "a",
				inputs: { x: { type: "string" } },
				agents: { p: { profile: "alpha", instructions: "i", filesystem: "read-only" } },
				steps: [{ id: "out", call: "p", prompt: "{{ inputs.x }}" }],
				output: "out",
			}),
			"b.json": JSON.stringify({
				id: "b",
				inputs: { y: { type: "string" } },
				agents: { p: { profile: "beta", instructions: "i", filesystem: "read-only" } },
				steps: [{ id: "out", call: "p", prompt: "{{ inputs.y }}" }],
				output: "out",
			}),
			"flow.json": JSON.stringify({
				id: "flow",
				inputs: { x: { type: "string" } },
				steps: [
					{ id: "s1", routine: "a", inputs: { x: "{{ inputs.x }}" } },
					{ id: "s2", routine: "b", inputs: { y: "{{ steps.s1.output }}" } },
				],
			}),
		};
		const read = (abs: string) => manifests[abs.split("/").pop() as string] as string;
		const resolve = (id: string) => resolveRoutine(config, id, "/x", read);
		const flow = resolveFlow(resolve("flow"), resolve);
		const ad1 = fakeAdapter((r) => `ad1(${r.prompt})`);
		const ad2 = fakeAdapter((r) => `ad2(${r.prompt})`);
		const adapter = dispatchingAdapter(config.agents, { ad1, ad2 });
		let t = 0;
		const res = await runFlow(
			flow,
			{ x: "GO" },
			{
				adapter,
				checkRunner: fakeCheckRunner(),
				sandboxFactory: fakeSandboxFactory(),
				cwd: "/x",
				now: () => ++t,
				newRunId: () => `r${t}`,
				apply: false,
			},
		);
		expect(res.receipt.status).toBe("completed");
		expect(ad1.calls.map((c) => c.agent)).toEqual(["alpha"]); // s1 -> ad1
		expect(ad2.calls[0]?.agent).toBe("beta"); // s2 -> ad2
		expect(ad2.calls[0]?.prompt).toContain("ad1(GO)"); // s1's output crossed into s2
	});
});
