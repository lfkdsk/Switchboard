#!/usr/bin/env bash
# Regenerate windows/Resources/Switchboard.ico from docs/logo.svg (full-bleed,
# which reads better than the macOS grid version at tray sizes). The .ico is
# committed, so the app build (and CI) needs no SVG tooling — only re-run this
# when the logo changes. Requires rsvg-convert (librsvg) and ImageMagick.
set -euo pipefail

WINDOWS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$WINDOWS_DIR/../docs/logo.svg"
OUT="$WINDOWS_DIR/Resources/Switchboard.ico"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (librsvg)" >&2; exit 1; }
MAGICK="$(command -v magick || command -v convert || true)"
[ -n "$MAGICK" ] || { echo "need ImageMagick (magick/convert)" >&2; exit 1; }

# Every size Windows asks for, rendered from the vector rather than scaled
# down from 256: the tray uses 16-32px and needs the crisp small renderings.
pngs=()
for s in 16 20 24 32 40 48 64 128 256; do
  rsvg-convert -w "$s" -h "$s" "$SVG" -o "$WORK/$s.png"
  pngs+=("$WORK/$s.png")
done
"$MAGICK" "${pngs[@]}" "$OUT"
echo "OK: wrote $OUT"
