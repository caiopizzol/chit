import { describe, expect, test } from "bun:test";
import { nonNegInt, nonNegNum } from "./usage.ts";

describe("usage guards", () => {
	test("nonNegInt accepts non-negative integers, rejects everything else", () => {
		expect(nonNegInt(0)).toBe(0);
		expect(nonNegInt(42)).toBe(42);
		expect(nonNegInt(-1)).toBeUndefined();
		expect(nonNegInt(1.5)).toBeUndefined();
		expect(nonNegInt(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(nonNegInt(Number.NaN)).toBeUndefined();
		expect(nonNegInt("5")).toBeUndefined();
		expect(nonNegInt(null)).toBeUndefined();
		expect(nonNegInt(undefined)).toBeUndefined();
	});

	test("nonNegNum accepts finite non-negative numbers incl. fractional, rejects the rest", () => {
		expect(nonNegNum(0)).toBe(0);
		expect(nonNegNum(0.0042)).toBe(0.0042);
		expect(nonNegNum(-0.01)).toBeUndefined();
		expect(nonNegNum(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(nonNegNum(Number.NaN)).toBeUndefined();
		expect(nonNegNum("1")).toBeUndefined();
	});
});
