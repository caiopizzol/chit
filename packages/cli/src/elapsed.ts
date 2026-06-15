// Compact human duration for the live progress stream: "42ms", "8s", "2m10s". The receipts keep
// exact elapsedMs; this is only the legible form shown as steps complete.
export function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60}s`;
}
