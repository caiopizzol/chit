import { describe, expect, test } from "bun:test";
import {
	type BatchApprovalBase,
	type BatchApprovalInput,
	buildBatchApprovalArtifact,
	canonicalBatchApprovalPayload,
} from "./approval.ts";

// The batch approval artifact binds a confirmed chit_batch_start to exactly what the dry run
// showed: the resolved base commit, the normalized task graph, and the batch-level execution
// knobs. These tests pin the canonical-payload contract the hash is computed over: object
// key-order independence, task LIST-ORDER sensitivity (the scheduler launches in list order,
// so a reorder is a real execution change), absent == omitted for every optional knob, and a
// different payload for any material change to a bound input.

const BASE: BatchApprovalBase = { ref: "main", sha: "abc123" };

const INPUT: BatchApprovalInput = {
	base: BASE,
	tasks: [
		{
			id: "scaffold",
			title: "Scaffold",
			body: "Create the module",
			dependencies: [],
			claimedPaths: ["src/mod/**"],
		},
		{
			id: "impl",
			title: "Implement",
			body: "Do the work",
			dependencies: ["scaffold"],
			claimedPaths: ["src/impl/**"],
		},
	],
	maxParallel: 2,
};

function payloadFor(input: BatchApprovalInput): string {
	return canonicalBatchApprovalPayload(buildBatchApprovalArtifact(input));
}

describe("canonicalBatchApprovalPayload determinism", () => {
	test("object key order in the source does not change the payload", () => {
		const a = payloadFor(INPUT);
		// Same graph, same task order, but every object's keys reversed: a different insertion
		// order, identical value. (Task list order is preserved -- see the next test.)
		const keysReversed: BatchApprovalInput = {
			maxParallel: 2,
			tasks: [
				{
					claimedPaths: ["src/mod/**"],
					dependencies: [],
					body: "Create the module",
					title: "Scaffold",
					id: "scaffold",
				},
				{
					claimedPaths: ["src/impl/**"],
					dependencies: ["scaffold"],
					body: "Do the work",
					title: "Implement",
					id: "impl",
				},
			],
			base: { sha: "abc123", ref: "main" },
		};
		expect(payloadFor(keysReversed)).toBe(a);
	});

	test("task list order changes the payload (it decides launch order)", () => {
		// selectRunnable iterates batch.tasks in order, so when a slot or claim conflict forces
		// serialization the list order picks the first wave. Two independent tasks in a swapped
		// order are a real execution change and must not share an approval hash.
		const ab = payloadFor({
			...INPUT,
			tasks: [
				{ id: "a", title: "A", body: "A", dependencies: [], claimedPaths: ["a/**"] },
				{ id: "b", title: "B", body: "B", dependencies: [], claimedPaths: ["b/**"] },
			],
		});
		const ba = payloadFor({
			...INPUT,
			tasks: [
				{ id: "b", title: "B", body: "B", dependencies: [], claimedPaths: ["b/**"] },
				{ id: "a", title: "A", body: "A", dependencies: [], claimedPaths: ["a/**"] },
			],
		});
		expect(ba).not.toBe(ab);
	});

	test("dependencies and claimedPaths bind as sets, not by order", () => {
		const a = payloadFor({
			...INPUT,
			tasks: [
				{
					id: "t",
					title: "T",
					body: "B",
					dependencies: ["a", "b"],
					claimedPaths: ["x", "y"],
				},
			],
		});
		const swapped = payloadFor({
			...INPUT,
			tasks: [
				{
					id: "t",
					title: "T",
					body: "B",
					dependencies: ["b", "a"],
					claimedPaths: ["y", "x"],
				},
			],
		});
		expect(swapped).toBe(a);
	});

	test("absent optional knobs equal explicit undefined", () => {
		const explicitUndefined = payloadFor({
			...INPUT,
			maxIterations: undefined,
			manifestPath: undefined,
			requiredChecks: undefined,
			callTimeoutMs: undefined,
			tasks: [
				{
					id: "t",
					title: "T",
					body: "B",
					dependencies: [],
					claimedPaths: ["x"],
					allowPathOverlap: undefined,
					manifestPath: undefined,
					requiredChecks: undefined,
					callTimeoutMs: undefined,
				},
			],
		});
		const omitted = payloadFor({
			...INPUT,
			tasks: [{ id: "t", title: "T", body: "B", dependencies: [], claimedPaths: ["x"] }],
		});
		expect(explicitUndefined).toBe(omitted);
	});

	test("allowPathOverlap:false equals an absent flag (default, no-op)", () => {
		const withFalse = payloadFor({
			...INPUT,
			tasks: [
				{
					id: "t",
					title: "T",
					body: "B",
					dependencies: [],
					claimedPaths: ["x"],
					allowPathOverlap: false,
				},
			],
		});
		const absent = payloadFor({
			...INPUT,
			tasks: [{ id: "t", title: "T", body: "B", dependencies: [], claimedPaths: ["x"] }],
		});
		expect(withFalse).toBe(absent);
	});

	test("a changed base ref or moved base sha changes the payload", () => {
		const first = payloadFor(INPUT);
		expect(payloadFor({ ...INPUT, base: { ref: "release", sha: "abc123" } })).not.toBe(first);
		expect(payloadFor({ ...INPUT, base: { ref: "main", sha: "def456" } })).not.toBe(first);
	});

	test("a changed task graph changes the payload", () => {
		const first = payloadFor(INPUT);
		// Changed brief body.
		expect(
			payloadFor({
				...INPUT,
				tasks: [INPUT.tasks[0], { ...INPUT.tasks[1], body: "Do the work DIFFERENTLY" }],
			}),
		).not.toBe(first);
		// Changed dependency edge.
		expect(
			payloadFor({
				...INPUT,
				tasks: [INPUT.tasks[0], { ...INPUT.tasks[1], dependencies: [] }],
			}),
		).not.toBe(first);
		// An added task.
		expect(
			payloadFor({
				...INPUT,
				tasks: [
					...INPUT.tasks,
					{ id: "extra", title: "Extra", body: "More", dependencies: [], claimedPaths: ["z"] },
				],
			}),
		).not.toBe(first);
		// allowPathOverlap flipped on.
		expect(
			payloadFor({
				...INPUT,
				tasks: [INPUT.tasks[0], { ...INPUT.tasks[1], allowPathOverlap: true }],
			}),
		).not.toBe(first);
	});

	test("a changed maxParallel changes the payload", () => {
		expect(payloadFor({ ...INPUT, maxParallel: 3 })).not.toBe(payloadFor(INPUT));
	});

	test("the optional maxIterations is bound into the payload", () => {
		const none = payloadFor(INPUT);
		const three = payloadFor({ ...INPUT, maxIterations: 3 });
		const five = payloadFor({ ...INPUT, maxIterations: 5 });
		expect(three).not.toBe(none);
		expect(five).not.toBe(three);
	});

	test("the batch manifestPath is bound into the payload", () => {
		expect(payloadFor({ ...INPUT, manifestPath: "/m/a.toml" })).not.toBe(payloadFor(INPUT));
		expect(payloadFor({ ...INPUT, manifestPath: "/m/b.toml" })).not.toBe(
			payloadFor({ ...INPUT, manifestPath: "/m/a.toml" }),
		);
	});

	test("the batch requiredChecks are bound into the payload", () => {
		const first = payloadFor(INPUT);
		expect(payloadFor({ ...INPUT, requiredChecks: [{ command: "bun", args: ["test"] }] })).not.toBe(
			first,
		);
	});

	test("a per-task requiredChecks change is bound into the payload", () => {
		const first = payloadFor(INPUT);
		expect(
			payloadFor({
				...INPUT,
				tasks: [
					INPUT.tasks[0],
					{ ...INPUT.tasks[1], requiredChecks: [{ command: "bun", args: ["test"] }] },
				],
			}),
		).not.toBe(first);
	});

	test("the batch callTimeoutMs is bound into the payload", () => {
		expect(payloadFor({ ...INPUT, callTimeoutMs: 1000 })).not.toBe(payloadFor(INPUT));
		expect(payloadFor({ ...INPUT, callTimeoutMs: 2000 })).not.toBe(
			payloadFor({ ...INPUT, callTimeoutMs: 1000 }),
		);
	});

	test("a per-task callTimeoutMs change is bound into the payload", () => {
		expect(
			payloadFor({
				...INPUT,
				tasks: [INPUT.tasks[0], { ...INPUT.tasks[1], callTimeoutMs: 5000 }],
			}),
		).not.toBe(payloadFor(INPUT));
	});

	test("the payload is valid canonical JSON of the artifact", () => {
		const artifact = buildBatchApprovalArtifact({ ...INPUT, maxIterations: 3 });
		expect(JSON.parse(canonicalBatchApprovalPayload(artifact))).toEqual(
			JSON.parse(JSON.stringify(artifact)),
		);
	});
});
