// Hono app for chit-studio. Routes only. The runtime entry (port binding,
// hostname, etc.) lives in index.tsx so this module is import-safe for tests.

import { readFileSync } from "node:fs";
import { buildGraphModel, parseManifest, parseRegistry, renderShow } from "@chit/core";
import { Hono } from "hono";
import { Home } from "./pages/home";
import { findWorkspaceRoot, PathError, resolveSafePath } from "./paths";

export const WORKSPACE_ROOT = findWorkspaceRoot(import.meta.dir);

export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

app.get("/", (c) => c.html(<Home />));

app.get("/inspect", (c) => {
	const userPath = c.req.query("path");
	if (!userPath) return c.redirect("/");

	let resolvedPath: string;
	try {
		resolvedPath = resolveSafePath(userPath, WORKSPACE_ROOT);
	} catch (e) {
		if (e instanceof PathError) {
			if (e.reason === "outside-workspace") {
				return c.html(
					<ErrorPage title="Path outside workspace" path={userPath} message={e.message} />,
					403,
				);
			}
			return c.html(
				<ErrorPage title="Could not read manifest" path={userPath} message={e.message} />,
				404,
			);
		}
		throw e;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
	} catch (e) {
		return c.html(
			<ErrorPage
				title="Manifest is not valid JSON"
				path={userPath}
				message={(e as Error).message}
			/>,
			400,
		);
	}

	try {
		const manifest = parseManifest(raw);
		const registry = parseRegistry(undefined);
		const surface = c.req.query("surface");
		const model = buildGraphModel(manifest, registry, surface);
		return c.html(renderShow(model, "html"));
	} catch (e) {
		return c.html(
			<ErrorPage title="Manifest did not parse" path={userPath} message={(e as Error).message} />,
			422,
		);
	}
});

const ERROR_STYLES = `
body { font-family: 'Inter', system-ui, sans-serif; background: #F4F2EA; color: #0A0A0A; padding: 32px; max-width: 720px; margin: 0 auto; }
h1 { font-family: 'Bricolage Grotesque', serif; font-size: 28px; margin: 0 0 16px; letter-spacing: -0.02em; }
p { line-height: 1.5; }
code { font-family: 'JetBrains Mono', monospace; background: #E0DBC6; padding: 1px 6px; font-size: 13px; }
pre { background: #E0DBC6; padding: 16px; overflow-x: auto; border-left: 3px solid #0A0A0A; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
a { color: #0A0A0A; }
`;

function ErrorPage(props: { title: string; path: string; message: string }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<title>chit studio · error</title>
				<style dangerouslySetInnerHTML={{ __html: ERROR_STYLES }} />
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
