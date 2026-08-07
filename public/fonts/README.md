# Vendored icon font

Nerd Font icons — Powerline separators, Devicons, Octicons, Font Awesome,
Codicons, Material Design — live in the Unicode private-use area. No system
monospace font covers those codepoints, so a prompt that uses them rendered as
tofu boxes in the browser terminal ([#7]).

`public/index.html` declares this font **last** in the xterm font stack, so
ordinary text still comes from the system monospace face and only private-use
codepoints fall through to here.

| File | Glyphs | Size | `unicode-range` |
| --- | --- | --- | --- |
| `SymbolsNerdFontMono-core.woff2` | 3623 | 635 KB | `U+23FB-23FE, U+2630, U+2665, U+26A1, U+276C-2771, U+2B58, U+E000-F8FF` |
| `SymbolsNerdFontMono-mdi.woff2` | 6896 | 500 KB | `U+F0001-F1AF0` |

The split is why Material Design — two thirds of the glyphs — is not in the
common path: the browser fetches that file only for a prompt that actually draws
one of its codepoints.

## Provenance

Subsets of `SymbolsNerdFontMono-Regular.ttf` from
[NerdFontsSymbolsOnly](https://github.com/ryanoasis/nerd-fonts/releases) v3.5.0,
MIT licensed (see `LICENSE`). Upstream ships the symbols with no alphabet, which
is what we want — the system font keeps rendering the text.

## Regenerating

Needs `pip install fonttools brotli`.

```python
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

SRC = "SymbolsNerdFontMono-Regular.ttf"          # from NerdFontsSymbolsOnly.zip
cmap = TTFont(SRC).getBestCmap()
is_mdi = lambda c: 0xF0001 <= c <= 0xF1AF0

def build(keep, out):
    f = TTFont(SRC)
    o = Options()
    o.layout_features = []          # icon glyphs need no shaping features
    o.drop_tables += ["DSIG", "PfEd"]
    o.notdef_outline = False        # a missing glyph must stay empty, never a box
    s = Subsetter(options=o)
    s.populate(unicodes=keep)
    s.subset(f)
    f.flavor = "woff2"
    f.save(out)

build([c for c in cmap if not is_mdi(c)], "SymbolsNerdFontMono-core.woff2")
build([c for c in cmap if is_mdi(c)],     "SymbolsNerdFontMono-mdi.woff2")
```

If a newer upstream release adds codepoints outside the ranges above, widen the
matching `unicode-range` in `public/index.html` — the browser will not even
fetch a file for a codepoint outside its declared range.

[#7]: https://github.com/lfkdsk/Switchboard/issues/7
