# The landing page

The project page at **https://lfkdsk.github.io/Switchboard/** — what Switchboard
is, and where to download it. Static HTML: no build step, no framework, no
runtime dependency on anything outside this directory.

It is dressed in [InkType](https://inktype.lfkdsk.org/), the editorial dark UI
system — Fraunces headlines, JetBrains Mono metadata, warm neutrals, one rust
accent. `styles/inktype.tokens.css` and `styles/inktype.components.css` are
vendored from that project unchanged (the only edit is dropping the `@import`,
since both files are linked directly).

```
site/
├── index.html                        the whole page
├── styles/
│   ├── fonts.css                     @font-face for the vendored faces
│   ├── inktype.tokens.css            InkType design tokens (vendored)
│   ├── inktype.components.css        InkType primitives (vendored)
│   └── site.css                      page layout — the only file that is ours
├── scripts/site.js                   language, theme, copy buttons, release lookup
├── fonts/                            Fraunces · Inter · JetBrains Mono (see its README)
├── assets/                           brand mark and favicon
└── preview.sh                        local preview, staged like CI does it
```

## Bilingual

Every translated run ships as a sibling pair, and CSS hides the inactive one:

```html
<span class="en">Works behind NAT</span><span class="zh">穿透 NAT</span>
```

The `<html data-lang>` attribute drives which is shown. An inline script in
`<head>` restores the stored choice — or guesses from `navigator.language` — so
neither language flashes on load. **Adding copy means adding both spans**; the
page has no translation table to fall back on.

Chinese text is not covered by the vendored Latin faces on purpose. It falls
through to a system CJK face via the stacks at the top of `site.css`, so no
multi-megabyte CJK webfont is ever downloaded. `site.css` also drops synthetic
italics and bumps the micro type scale for Han runs, both of which look broken
otherwise.

## Without JavaScript

The page is readable and the downloads work: English copy, dark theme, and the
`.dmg` buttons pointing at `releases/latest`. `site.js` only upgrades things —
it swaps the language, the theme, wires the copy buttons, and rewrites the
download buttons to the exact assets on the newest release (falling back
silently when the GitHub API is rate-limited or unreachable).

## Preview

```bash
site/preview.sh          # → http://localhost:8000
```

This stages `_site/` exactly the way `.github/workflows/pages.yml` does,
including copying the screenshots out of `docs/`. Opening `index.html` straight
off disk shows the page but not those two images — they live in `docs/` so the
README and the site share one copy.

## Deploying

`.github/workflows/pages.yml` publishes on every push to `main` that touches
`site/`, the shared screenshots, or the workflow itself; it can also be run by
hand from the Actions tab.

Nothing to configure by hand: `configure-pages` runs with `enablement: true`,
so the first run switches Pages on (source: GitHub Actions) and deploys.
Without that flag the action 404s on a repository where Pages has never been
set up, which is how the very first deploy of this page failed.
