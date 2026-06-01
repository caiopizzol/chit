import { notFound } from "next/navigation";
import { getLLMText, source } from "@/lib/source";

export const dynamic = "force-static";
export const revalidate = false;

// Per-page raw Markdown at /llms.mdx/<...slug>/content.md, for agents that
// want one page's text without scraping HTML.
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
	const { slug = [] } = await params;
	const page = source.getPage(slug.slice(0, -1)); // drop trailing "content.md"
	if (!page) notFound();

	return new Response(await getLLMText(page), {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
}

export function generateStaticParams() {
	return source.generateParams().map((entry) => ({
		slug: [...(entry.slug ?? []), "content.md"],
	}));
}
