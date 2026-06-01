// Bundles the client React app to dist/client/. Run via:
//   bun --filter @chit-run/studio build:client
// or from this workspace:
//   bun run build:client
//
// The server (src/server/index.ts) serves dist/client/index.js and
// dist/client/index.css. There is no dev-server / HMR in slice 1; rebuild
// after each client change. HMR is a slice-1-polish-or-later concern.

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE = resolve(import.meta.dir, "..");
const OUT = resolve(WORKSPACE, "dist", "client");
const ENTRY = resolve(WORKSPACE, "src", "client", "index.tsx");

rmSync(OUT, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [ENTRY],
	outdir: OUT,
	target: "browser",
	minify: true,
	naming: "[name].[ext]",
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

const sizes = result.outputs
	.map((o) => `  ${o.path.replace(`${WORKSPACE}/`, "")} (${o.kind})`)
	.join("\n");
console.log(`bundled ${result.outputs.length} outputs:\n${sizes}`);
