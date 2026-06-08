// Bundles the CLI into a single self-contained dist/chit.js for publishing.
// Everything (the @chit-run/core and @chit-run/studio workspaces, plus the
// third-party deps) is inlined, so the published package has no runtime
// dependencies. The binary targets Bun: the CLI uses Bun.spawn / Bun.stdin and
// Studio uses Bun.serve, so it runs under `bunx`, not plain Node.
//
// @chit-run/core and @chit-run/studio stay as workspace:* devDependencies so the
// source resolves under tsc and bun, but they are inlined here, so the published
// package carries no runtime dependencies. The release publishes with
// `bun publish` (not npm), which understands the workspace: protocol.
//
// The Studio server serves its React client bundle from disk, not from the JS
// bundle. So this build also produces apps/cli/dist/client/ and `chit studio`
// resolves it next to chit.js (see runStudio). Without this, a published install
// boots Studio but returns 503 for /client/index.js. The release runs only
// `cd apps/cli && bun run build`, so the client build has to happen here rather
// than in a separate workspace step.
import { chmodSync, cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI_DIR = import.meta.dir;
const STUDIO_DIR = resolve(CLI_DIR, "..", "studio");

// Build the Studio client first, so the assets we copy below are fresh.
const clientBuild = Bun.spawnSync(["bun", "scripts/build-client.ts"], {
	cwd: STUDIO_DIR,
	stdout: "inherit",
	stderr: "inherit",
});
if (clientBuild.exitCode !== 0) {
	console.error("studio client build failed");
	process.exit(clientBuild.exitCode ?? 1);
}

const studioClient = resolve(STUDIO_DIR, "dist", "client");
if (!existsSync(studioClient)) {
	console.error(`studio client bundle missing at ${studioClient} after build`);
	process.exit(1);
}

const result = await Bun.build({
	entrypoints: ["src/cli/run.ts"],
	target: "bun",
});

if (!result.success) {
	for (const message of result.logs) console.error(message);
	process.exit(1);
}

const code = await result.outputs[0].text();
const outPath = "dist/chit.js";
await Bun.write(outPath, `#!/usr/bin/env bun\n${code}`);
chmodSync(outPath, 0o755);

// Copy the Studio client next to chit.js so the packaged `chit studio` serves it.
cpSync(studioClient, resolve(CLI_DIR, "dist", "client"), { recursive: true });

console.log(`built ${outPath} (${(code.length / 1024).toFixed(0)} KB) + dist/client`);
