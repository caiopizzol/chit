import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const revalidate = false;

// Builds a static Orama index at export time, served at /api/search.
// https://docs.orama.com/docs/orama-js/supported-languages
export const { staticGET: GET } = createFromSource(source, {
	language: "english",
});
