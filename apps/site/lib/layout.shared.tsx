import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "./shared";

// The chit wordmark: always lowercase, always mono (brand.md → Visual).
function ChitLogo() {
	return (
		<span
			style={{
				fontFamily: "var(--font-chit-mono), monospace",
				fontWeight: 600,
				fontSize: "1.0625rem",
				letterSpacing: "-0.01em",
			}}
		>
			{appName}
		</span>
	);
}

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: <ChitLogo />,
			url: "/",
		},
		links: [
			{ text: "Docs", url: "/docs" },
			{
				text: "GitHub",
				url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
				external: true,
			},
		],
		// Light paper/ink only, matching the landing. No toggle to a theme
		// that does not exist.
		themeSwitch: { enabled: false },
	};
}
