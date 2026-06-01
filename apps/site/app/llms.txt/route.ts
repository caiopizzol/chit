import { source } from "@/lib/source";

export const revalidate = false;
export const dynamic = "force-static";

// A compact index of the docs for agents to discover, with links to the
// full text of each page. Pairs with /llms-full.txt.
export function GET() {
	const lines = source.getPages().map((page) => `- [${page.data.title}](${page.url})`);

	const body = [
		"# chit",
		"",
		"A thin runtime for multi-agent workflows.",
		"",
		"## Docs",
		"",
		...lines,
		"",
		"Full text: /llms-full.txt",
		"",
	].join("\n");

	return new Response(body);
}
