// chit Studio entry. Local Bun + Hono server. Track A: read-only viewer.
//
// Routes:
//   GET /                   landing form: enter a manifest path, or pick a canonical example
//   GET /inspect?path=...   parse the manifest, render the @chit/core graph
//   GET /healthz            liveness
//
// Track A scope: no editing yet. No run button. The graph view IS the
// existing @chit/core renderShow output (html format); future iterations
// layer click-to-inspect panels and structured forms on top.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGraphModel, parseManifest, parseRegistry, renderShow } from "@chit/core";
import { Hono } from "hono";
import { Home } from "./pages/home";

const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

app.get("/", (c) => c.html(<Home />));

app.get("/inspect", (c) => {
	const path = c.req.query("path");
	if (!path) return c.redirect("/");

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolve(path), "utf-8"));
	} catch (e) {
		return c.html(
			<ErrorPage title="Could not read manifest" path={path} message={(e as Error).message} />,
			400,
		);
	}

	try {
		const manifest = parseManifest(raw);
		const registry = parseRegistry(undefined);
		const surface = c.req.query("surface");
		const model = buildGraphModel(manifest, registry, surface);
		// renderShow returns a complete HTML document. For Track A we return
		// it as-is; future versions will wrap it in a Studio chrome with
		// nav, breadcrumb, and an interactive inspector side panel.
		return c.html(renderShow(model, "html"));
	} catch (e) {
		return c.html(
			<ErrorPage title="Manifest did not parse" path={path} message={(e as Error).message} />,
			422,
		);
	}
});

function ErrorPage(props: { title: string; path: string; message: string }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<title>chit studio · error</title>
				<style
					dangerouslySetInnerHTML={{
						__html: `
					body { font-family: ui-monospace, monospace; background: #F4F2EA; color: #0A0A0A; padding: 32px; max-width: 720px; margin: 0 auto; }
					h1 { font-family: 'Bricolage Grotesque', serif; font-size: 28px; margin: 0 0 16px; }
					pre { background: #E0DBC6; padding: 16px; overflow-x: auto; border-left: 3px solid #0A0A0A; }
					a { color: #0A0A0A; }
				`,
					}}
				/>
			</head>
			<body>
				<h1>{props.title}</h1>
				<p>
					path: <code>{props.path}</code>
				</p>
				<pre>{props.message}</pre>
				<p>
					<a href="/">back</a>
				</p>
			</body>
		</html>
	);
}

const port = Number(process.env.PORT) || 3030;

export default {
	port,
	fetch: app.fetch,
};

console.log(`chit studio listening on http://localhost:${port}`);
