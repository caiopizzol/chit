// A tiny, explicit template renderer for step prompts and format strings.
// Two reference forms only:
//   {{ inputs.<name> }}        -- an operator-supplied input
//   {{ steps.<id>.output }}    -- the output of an earlier step
// Anything else throws, so a typo surfaces as a clear error instead of leaking
// an empty hole or an unrendered brace into a model prompt.

export class TemplateError extends Error {
	constructor(detail: string) {
		super(detail);
		this.name = "TemplateError";
	}
}

export interface RenderContext {
	inputs: Record<string, string>;
	steps: Record<string, { output: string }>;
}

const REF_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

export function renderTemplate(template: string, ctx: RenderContext): string {
	return template.replace(REF_RE, (_match, raw: string) => {
		const expr = raw.trim();
		const parts = expr.split(".");
		if (parts[0] === "inputs" && parts.length === 2 && parts[1]) {
			// An absent (optional) input renders empty -- it was validated already if required.
			return ctx.inputs[parts[1]] ?? "";
		}
		if (parts[0] === "steps" && parts.length === 3 && parts[1] && parts[2] === "output") {
			const step = ctx.steps[parts[1]];
			if (step === undefined) {
				throw new TemplateError(`template references step "${parts[1]}" before it has run`);
			}
			return step.output;
		}
		throw new TemplateError(`unsupported template reference: {{ ${expr} }}`);
	});
}
