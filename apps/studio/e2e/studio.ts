// Launches a real `chit studio <temp-fixture>` server for an e2e test.
// Copies the named fixture manifest into a fresh temp dir (so disk
// assertions are isolated and writes do not touch the repo), spawns the CLI
// subcommand, and parses the printed URL. The temp file path is returned so
// a test can read it back after a save.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "cli", "src", "cli", "run.ts");
const FIXTURES = join(here, "fixtures");

export interface StudioInstance {
	url: string;
	file: string;
	close: () => Promise<void>;
}

export async function launchStudio(fixtureName: string): Promise<StudioInstance> {
	const dir = mkdtempSync(join(tmpdir(), "chit-e2e-"));
	const file = join(dir, fixtureName);
	cpSync(join(FIXTURES, fixtureName), file);

	const child: ChildProcess = spawn("bun", [CLI, "studio", fixtureName], { cwd: dir });

	const url = await new Promise<string>((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`studio did not start:\n${buf}`)), 20000);
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const m = buf.match(/chit studio: (http:\/\/\S+)/);
			if (m?.[1]) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			buf += d.toString();
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`studio exited (${code}) before printing a URL:\n${buf}`));
		});
	});

	return {
		url,
		file,
		close: async () => {
			child.kill("SIGINT");
			await new Promise((r) => setTimeout(r, 250));
			if (child.exitCode === null) child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
