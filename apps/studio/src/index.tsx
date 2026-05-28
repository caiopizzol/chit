// chit Studio entry. Local Bun + Hono server. Bound to 127.0.0.1 by default
// so localhost is the only thing that can reach it; arbitrary processes on
// the LAN cannot. See app.tsx for routes and paths.ts for the
// workspace-root resolution and path-traversal guard.

import { app, WORKSPACE_ROOT } from "./app";

const port = Number(process.env.PORT) || 3030;
const hostname = process.env.HOST || "127.0.0.1";

console.log(`chit studio listening on http://${hostname}:${port}`);
console.log(`workspace root: ${WORKSPACE_ROOT}`);

export default {
	port,
	hostname,
	fetch: app.fetch,
};
