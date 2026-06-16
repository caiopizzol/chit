// A during-call heartbeat. A model call or a check can run for minutes; Chit already prints a
// start line and a "done in" line, but nothing in between -- a long step looks stalled. This
// wraps an in-flight call/check and emits a periodic progress line while it runs.
//
// Real-time only: it uses a wall-clock timer that is unref'd (so it never keeps the process
// alive) and cleared the instant the work settles (success OR error). Under test the wrapped
// work resolves immediately, so the interval never fires and progress output is unchanged --
// the heartbeat is invisible to the deterministic suite.

import { formatElapsed } from "./elapsed.ts";

export const DEFAULT_HEARTBEAT_MS = 30_000;

export async function withHeartbeat<T>(
	fn: () => Promise<T>,
	opts: { label: string; now: () => number; onProgress?: (line: string) => void; intervalMs?: number },
): Promise<T> {
	// No sink, no heartbeat -- run the work untouched (and pay no timer cost).
	if (opts.onProgress === undefined) return fn();
	const onProgress = opts.onProgress;
	const start = opts.now();
	const timer = setInterval(() => {
		onProgress(`  ${opts.label} still running... ${formatElapsed(opts.now() - start)}`);
	}, opts.intervalMs ?? DEFAULT_HEARTBEAT_MS);
	// Never let a heartbeat hold the event loop open on its own.
	(timer as { unref?: () => void }).unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(timer);
	}
}
