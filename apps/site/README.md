# @chit-run/site

The chit documentation site and marketing landing. Next.js + Fumadocs, static
export (`output: "export"`), deployable to Cloudflare.

The site serves:

- `/` - the marketing landing (a bespoke page, not Fumadocs doc chrome).
- `/docs` and `/docs/<slug>` - the docs, for humans.
- `/llms.txt` and `/llms-full.txt` - for agents that ingest docs ahead of time.
- `/llms.mdx/<slug>/content.md` - a single page's raw Markdown.
- `/api/search` - a static Orama search index (search runs in the browser).
- `/sitemap.xml` and `/robots.txt`.

## Scripts

```sh
bun run dev        # local dev server
bun run build      # static export to apps/site/out
bun run preview    # serve the built site
bun run typecheck  # fumadocs-mdx typegen + tsc
bun run check      # biome
```

From the repo root: `bun run site:dev`, `bun run site:build`,
`bun run site:preview`, and `bun run site:typecheck` (the `docs:*` names
still work as aliases).

## Layout

- `content/docs/*.mdx` - the docs. Frontmatter is `title` + `description`;
  `meta.json` sets the sidebar order.
- `app/page.tsx` + `app/landing.css` - the bespoke marketing landing, scoped
  under `.landing` so it does not inherit docs chrome.
- `app/docs/` - the Fumadocs docs section.
- `app/chit-theme.css` - maps Fumadocs `--color-fd-*` tokens to chit's
  paper/ink palette (light only; the theme toggle is disabled).
- `app/{llms.txt,llms-full.txt,llms.mdx}` and `app/api/search` - agent and
  search endpoints, generated from the same MDX source.
- `fonts/` - self-hosted variable fonts (`next/font/local`), so the build needs
  no network. See `fonts/README.md`.

## Notes

- The build output goes to `out/`. Deploy that directory to Cloudflare Pages as
  the public `chit.run` site, with docs served under `/docs`.
- `next.config.mjs` sets `typescript.ignoreBuildErrors` because the Fumadocs MDX
  static template's `page.data.body` type does not survive its typegen under
  strict TS. Runtime is fine; run `bun run typecheck` to surface type issues.
