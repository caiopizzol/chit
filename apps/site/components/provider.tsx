"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export function Provider({ children }: { children: ReactNode }) {
	return (
		<RootProvider
			// Light paper/ink only: do not let next-themes flip to dark.
			theme={{ enabled: false }}
			// Static export ships a prebuilt Orama index; the client runs the
			// search in the browser instead of calling a live endpoint.
			search={{ options: { type: "static" } }}
		>
			{children}
		</RootProvider>
	);
}
