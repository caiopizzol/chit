import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DerivedBehavior, FilesystemScale } from "./config-visuals";
import { SandboxApplyVisual } from "./doc-visuals";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
	return {
		...defaultMdxComponents,
		// Brand doc visuals.
		SandboxApplyVisual,
		// Config reference visuals.
		DerivedBehavior,
		FilesystemScale,
		...components,
	};
}
