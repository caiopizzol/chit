import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { siteUrl } from "@/lib/shared";
import "./global.css";
import "./chit-theme.css";

// Self-hosted variable fonts (brand.md -> Visual). Bundled from local
// .woff2 files so `next build` needs no network: deterministic CI/offline
// builds and no runtime Google Fonts request. Files + license note live in
// apps/site/fonts/.
const inter = localFont({
	src: "../fonts/inter-variable.woff2",
	variable: "--font-chit-body",
	weight: "100 900",
	display: "swap",
});
const bricolage = localFont({
	src: "../fonts/bricolage-grotesque-variable.woff2",
	variable: "--font-chit-display",
	weight: "200 800",
	display: "swap",
});
const jetbrains = localFont({
	src: "../fonts/jetbrains-mono-variable.woff2",
	variable: "--font-chit-mono",
	weight: "100 800",
	display: "swap",
});

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: { default: "chit", template: "%s - chit" },
	description:
		"Versioned, cross-vendor agent routines with an audit trail. Stop being the glue between your agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${inter.variable} ${bricolage.variable} ${jetbrains.variable}`}
			suppressHydrationWarning
		>
			<body className="flex flex-col min-h-screen">
				<Provider>{children}</Provider>
			</body>
		</html>
	);
}
