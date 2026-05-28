# chit-web

The chit landing site. Hono on Cloudflare Workers with Static Assets.

## Local development

```sh
bun run dev          # wrangler dev on http://localhost:8787
```

Edit `src/pages/home.tsx` and reload. Wrangler restarts on file change.

## Deploy

Cloudflare account required. One-time per machine:

```sh
bunx wrangler login
```

Then from this directory:

```sh
bun run deploy
```

The Worker deploys to `chit-web.<your-account>.workers.dev` until a custom domain is added.

## Adding a custom domain

When the brand domain is secured (planned: `chitgraph.com`):

1. Add the domain as a Cloudflare zone.
2. Edit `wrangler.toml`:
   - Set `workers_dev = false` (or delete the line if you want both).
   - Uncomment the `[[routes]]` blocks at the bottom and replace the pattern.
3. `bun run deploy`.

The `custom_domain = true` flag handles DNS for you (no `_workers` CNAME needed).

## What's deployed

- `src/index.tsx` — the Hono Worker. Single `GET /` route that renders the landing page.
- `src/pages/home.tsx` — the page itself. Imports inline CSS from `src/styles.ts`.
- `public/` — static assets served via the `ASSETS` binding. Empty today; add favicon, og images, robots.txt here as needed.

## Stack

- **Hono** for SSR JSX (`jsx: react-jsx`, `jsxImportSource: hono/jsx`).
- **Cloudflare Workers** with Static Assets (the current direction CF is migrating Pages users to).
- **Bun** as package manager and dev runtime.
- **Wrangler 4** for deploy and local dev.

No build step. Wrangler bundles the Worker on deploy. JSX renders to HTML on every request.
