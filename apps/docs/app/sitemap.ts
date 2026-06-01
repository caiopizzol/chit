import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	const docs = source.getPages().map((page) => ({
		url: `${siteUrl}${page.url}`,
	}));
	return [{ url: siteUrl }, { url: `${siteUrl}/docs` }, ...docs];
}
