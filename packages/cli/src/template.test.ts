import { describe, expect, test } from "bun:test";
import { renderTemplate, TemplateError } from "./template.ts";

const ctx = {
	inputs: { idea: "dark mode", context: "" },
	steps: { grill: { output: "## Questions\n1. ..." } },
};

describe("renderTemplate", () => {
	test("substitutes inputs", () => {
		expect(renderTemplate("Idea: {{ inputs.idea }}", ctx)).toBe("Idea: dark mode");
	});

	test("tolerates whitespace inside the braces", () => {
		expect(renderTemplate("{{inputs.idea}} / {{   inputs.idea   }}", ctx)).toBe("dark mode / dark mode");
	});

	test("renders an absent optional input as empty", () => {
		expect(renderTemplate("[{{ inputs.missing }}]", ctx)).toBe("[]");
	});

	test("substitutes a prior step's output", () => {
		expect(renderTemplate("{{ steps.grill.output }}", ctx)).toContain("## Questions");
	});

	test("throws when a step has not run yet", () => {
		expect(() => renderTemplate("{{ steps.future.output }}", ctx)).toThrow(TemplateError);
	});

	test("throws on an unsupported reference", () => {
		expect(() => renderTemplate("{{ secrets.token }}", ctx)).toThrow(/unsupported template reference/);
		expect(() => renderTemplate("{{ steps.grill.prompt }}", ctx)).toThrow(/unsupported template reference/);
	});

	test("leaves text without references untouched", () => {
		expect(renderTemplate("plain text", ctx)).toBe("plain text");
	});

	test("renders the iteration number inside a loop context", () => {
		expect(renderTemplate("iter {{ iteration }}", { ...ctx, iteration: 2 })).toBe("iter 2");
	});

	test("throws on {{ iteration }} outside a loop", () => {
		expect(() => renderTemplate("{{ iteration }}", ctx)).toThrow(/only valid inside a converge loop/);
	});

	test("a pre-seeded cross-iteration step ref renders its (possibly empty) value", () => {
		const seeded = { inputs: {}, steps: { critique: { output: "" } }, iteration: 1 };
		expect(renderTemplate("[{{ steps.critique.output }}]", seeded)).toBe("[]");
	});
});
