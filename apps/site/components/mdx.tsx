import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Banner } from "fumadocs-ui/components/banner";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import {
	AnnotatedConfig,
	DerivedBehavior,
	FilesystemScale,
	LoopConditionCards,
	RejectList,
	StepKindGrid,
} from "./config-visuals";
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
		// Fumadocs built-ins used by the config reference and the /docs/mockups experiment.
		TypeTable,
		Tabs,
		Tab,
		Steps,
		Step,
		Files,
		Folder,
		File,
		Accordions,
		Accordion,
		Banner,
		// Existing brand doc visuals.
		GoalLoopVisual,
		MultiModelPanelVisual,
		RoutinePipelineVisual,
		SandboxApplyVisual,
		TerminalDemoVisual,
		// Config mockup visuals (EXPERIMENTAL; remove with content/docs/mockups).
		StepKindGrid,
		FilesystemScale,
		LoopConditionCards,
		DerivedBehavior,
		AnnotatedConfig,
		RejectList,
		...components,
	};
}
