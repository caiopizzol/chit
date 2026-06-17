// Bounded per-step evidence stored on receipts. This keeps failed-run receipts
// useful without turning .chit/runs into unbounded transcript dumps.

export const MAX_STEP_OUTPUT_CHARS = 2000;

export function capStepOutput(text: string): string | undefined {
	if (!text) return undefined;
	if (text.length <= MAX_STEP_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_STEP_OUTPUT_CHARS)}\n... [truncated: ${text.length} chars total]`;
}
