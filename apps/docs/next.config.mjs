import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	output: "export",
	reactStrictMode: true,
	// The Fumadocs MDX static template uses `page.data.body`, whose type
	// does not survive Fumadocs MDX's typegen under strict TS. Runtime is
	// fine. Do not block the static export on type errors; `bun run
	// typecheck` is the place that surfaces them.
	typescript: {
		ignoreBuildErrors: true,
	},
};

export default withMDX(config);
