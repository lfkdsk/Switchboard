# Vendored webfaces

The three InkType voices — **Fraunces** (serif), **Inter** (sans), **JetBrains
Mono** (mono) — served from this repo instead of `fonts.googleapis.com`.

That host is unreachable from mainland China and half the landing page is in
Chinese, so a CDN miss there would strip the design of the typography it is
built on. Same reasoning as [`public/fonts/`](../../public/fonts/README.md).

| File | Face | Weights |
| --- | --- | --- |
| `fraunces-normal-300600-latin.woff2` | Fraunces, roman | variable 300–600 |
| `fraunces-italic-300600-latin.woff2` | Fraunces, italic | variable 300–600 |
| `inter-normal-400-latin.woff2` | Inter | 400 |
| `inter-normal-600-latin.woff2` | Inter | 600 |
| `jetbrainsmono-normal-400-latin.woff2` | JetBrains Mono | 400 |
| `jetbrainsmono-normal-500-latin.woff2` | JetBrains Mono | 500 |

**Latin subset only** (~310 KB total). The Chinese copy is not covered by these
files by design — it falls through to a system CJK face via the font stacks in
[`../styles/site.css`](../styles/site.css), so no CJK webfont (megabytes) is ever
downloaded. The `@font-face` blocks carry Google's original `unicode-range`, so
a browser only fetches a file when the page actually needs a glyph from it.

## Regenerating

Fetch the CSS with a browser UA (otherwise Google serves `ttf`), keep the
`/* latin */` blocks, download each `woff2`, and rewrite the `src:` URLs to
`../fonts/<file>` in [`../styles/fonts.css`](../styles/fonts.css):

```bash
curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap'
```

Both `fonts.css` and this directory are the only places that need updating —
nothing in `index.html` names a font file except the two `<link rel="preload">`
hints for Fraunces roman and JetBrains Mono 400.

## Licences

All three families are licensed under the [SIL Open Font License 1.1](https://scripts.sil.org/OFL):
Fraunces by Undercase Type, Inter by Rasmus Andersson, JetBrains Mono by JetBrains.
