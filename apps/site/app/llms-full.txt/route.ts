import { getLLMText, source } from "@/lib/source";

export const revalidate = false;
export const dynamic = "force-static";

// The full text of every docs page, concatenated, for agents that ingest
// documentation ahead of time.
export async function GET() {
	const scanned = await Promise.all(source.getPages().map(getLLMText));
	return new Response(scanned.join("\n\n"));
}
