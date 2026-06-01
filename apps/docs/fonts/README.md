# Fonts

Self-hosted variable fonts for the docs site, loaded via `next/font/local` in
`app/layout.tsx`. They are bundled at build time so `next build` needs no
network access (deterministic CI/offline builds, no runtime Google Fonts
request).

All three are licensed under the SIL Open Font License 1.1 (OFL-1.1).

| File | Family | Source | License |
| --- | --- | --- | --- |
| `inter-variable.woff2` | Inter (variable) | https://github.com/rsms/inter | OFL-1.1 |
| `bricolage-grotesque-variable.woff2` | Bricolage Grotesque (variable) | https://github.com/ateliertriay/bricolage | OFL-1.1 |
| `jetbrains-mono-variable.woff2` | JetBrains Mono (variable) | https://github.com/JetBrains/JetBrainsMono | OFL-1.1 |

The `.woff2` files are the Latin variable subsets repackaged by
[Fontsource](https://fontsource.org/). The full OFL-1.1 text and copyright
notice for each family is committed alongside the fonts: `Inter-OFL.txt`,
`BricolageGrotesque-OFL.txt`, and `JetBrainsMono-OFL.txt`.
