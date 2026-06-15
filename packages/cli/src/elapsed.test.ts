import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./elapsed.ts";

describe("formatElapsed", () => {
	test("sub-second shows ms", () => {
		expect(formatElapsed(0)).toBe("0ms");
		expect(formatElapsed(42)).toBe("42ms");
		expect(formatElapsed(999)).toBe("999ms");
	});

	test("seconds", () => {
		expect(formatElapsed(8000)).toBe("8s");
		expect(formatElapsed(8400)).toBe("8s");
	});

	test("minutes and seconds (the long-call case)", () => {
		expect(formatElapsed(130_000)).toBe("2m10s");
		expect(formatElapsed(194_000)).toBe("3m14s");
	});
});
