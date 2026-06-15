import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import {
	GoalLoopVisual,
	MultiModelPanelVisual,
	RoutinePipelineVisual,
	SandboxApplyVisual,
	TerminalDemoVisual,
	TwoFileVisual,
} from "./doc-visuals";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
	return {
		...defaultMdxComponents,
		GoalLoopVisual,
		MultiModelPanelVisual,
		RoutinePipelineVisual,
		SandboxApplyVisual,
		TerminalDemoVisual,
		TwoFileVisual,
		...components,
	};
}
