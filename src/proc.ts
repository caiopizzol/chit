// One place to spawn a child process and capture its output, with an optional
// timeout that kills a hung process. Both real seams -- the claude adapter and
// the argv check-runner -- go through here, so a hung model call or a hung check
// can never block a run forever. The timeout is a real safety bound, not polish.

export interface ProcResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export async function spawnCapture(
	cmd: string[],
	opts: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<ProcResult> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		...(opts.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
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
	return { exitCode, stdout, stderr, timedOut };
}
