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

The Worker deploys to `chit.run` (the live custom domain) and to `chit-web.<your-account>.workers.dev` (kept alive as a no-DNS fallback for testing).

## Custom domain

`chit.run` is wired in `wrangler.toml` under `[[routes]]` with `custom_domain = true`, which handles DNS via Cloudflare automatically (no `_workers` CNAME needed). The domain must be added as a Cloudflare zone before the first deploy.

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
