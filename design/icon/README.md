# chit icon

The mark is a lowercase `c` with the seal dot punched into the counter. Ink on
paper, no accent color, per `brand.md`. The `c` references the wordmark; the dot
references the `● SEALED` seal indicator.

## SOURCE FILES

- `chit-icon.svg` - paper tile, ink glyph. The primary mark. Legible on any
  background because the tile carries its own contrast. Source for `favicon.ico`.
- `chit-icon-adaptive.svg` - transparent, ink on light and paper on dark via
  `prefers-color-scheme`. Shipped as the live SVG favicon.
- `chit-icon-transparent-light.svg` - transparent, ink glyph. Light surfaces only.
- `chit-icon-transparent-dark.svg` - transparent, paper glyph. Dark surfaces only.

All four share one geometry: a 512 viewBox, a stroked ring with a gap on the
right (a `c`), and a centered dot. The gap is placed with `stroke-dashoffset`.

## LIVE WIRING

The site uses Next.js App Router file conventions in `apps/site/app/`:

- `icon.svg` - copy of `chit-icon-adaptive.svg`. Modern browsers prefer it and
  it adapts to the tab-bar scheme.
- `favicon.ico` - 16/32/48 raster of `chit-icon.svg` (the tiled mark). Fallback
  for clients that ignore SVG favicons; the tile keeps it legible in both schemes.
- `apple-icon.png` - 180px raster of `chit-icon.svg`. The opaque tile is correct
  for an iOS home-screen icon.

## REGENERATING RASTERS

ImageMagick's SVG renderer mishandles `stroke-dasharray`, so rasterize with the
macOS WebKit renderer, then package:

```sh
for s in 16 32 48 180; do
  qlmanage -t -s $s -o . chit-icon.svg && mv chit-icon.svg.png chit-icon-$s.png
done
magick chit-icon-16.png chit-icon-32.png chit-icon-48.png favicon.ico
```
