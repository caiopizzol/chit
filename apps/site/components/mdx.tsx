import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DerivedBehavior, FilesystemScale } from "./config-visuals";
import {
	GoalLoopVisual,
	MultiModelPanelVisual,
	RoutinePipelineVisual,
	SandboxApplyVisual,
	TerminalDemoVisual,
} from "./doc-visuals";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
	return {
		...defaultMdxComponents,
		// Brand doc visuals.
		GoalLoopVisual,
		MultiModelPanelVisual,
		RoutinePipelineVisual,
		SandboxApplyVisual,
		TerminalDemoVisual,
		// Config reference visuals.
		DerivedBehavior,
		FilesystemScale,
		...components,
	};
}
