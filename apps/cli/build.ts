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
import { chmodSync } from "node:fs";

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

console.log(`built ${outPath} (${(code.length / 1024).toFixed(0)} KB)`);
