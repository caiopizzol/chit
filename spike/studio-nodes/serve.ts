// Minimal static server for the Slice 0 spike. Serves ./dist on 127.0.0.1.

const port = Number(process.env.PORT) || 4040;
const hostname = "127.0.0.1";

Bun.serve({
	port,
	hostname,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(`./dist${path}`);
		if (!(await file.exists())) return new Response("not found", { status: 404 });
		return new Response(file);
	},
});

console.log(`spike at http://${hostname}:${port}`);
