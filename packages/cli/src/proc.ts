// One place to spawn a child process and capture its output, with an optional
// timeout that kills a hung process and an optional abort signal that kills it on
// cancellation. Both real seams -- the claude adapter and the argv check-runner --
// go through here, so a hung model call or a hung check can never block a run, and a
// Ctrl-C can stop the in-flight subprocess promptly instead of waiting for the
// timeout. The timeout and the signal are real safety bounds, not polish.

export interface ProcResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	// True when an external abort signal killed the process (operator cancellation),
	// as distinct from a timeout or a normal non-zero exit.
	aborted: boolean;
}

function currentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

export async function spawnCapture(
	cmd: string[],
	opts: { cwd: string; stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ProcResult> {
	// Already cancelled before we even start: don't spawn anything.
	if (opts.signal?.aborted) {
		return { exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true };
	}
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		env: currentEnv(),
		...(opts.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		proc.kill();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timer =
		opts.timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, opts.timeoutMs)
			: undefined;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== undefined) clearTimeout(timer);
	opts.signal?.removeEventListener("abort", onAbort);
	return { exitCode, stdout, stderr, timedOut, aborted };
}
