import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { docsContentRoute, docsRoute } from "./shared";

// https://fumadocs.dev/docs/headless/source-api
export const source = loader({
	baseUrl: docsRoute,
	source: docs.toFumadocsSource(),
});

// URL of a page's raw Markdown (served by app/llms.mdx/[[...slug]]/route.ts).
export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
	return `${docsContentRoute}/${[...page.slugs, "content.md"].join("/")}`;
}

// Plain-text rendering of a page for the llms.txt / llms-full.txt routes.
export async function getLLMText(page: (typeof source)["$inferPage"]) {
	const processed = await page.data.getText("processed");
	return `# ${page.data.title} (${page.url})\n\n${processed}`;
}
