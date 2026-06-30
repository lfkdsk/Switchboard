#!/usr/bin/env bash
# Regenerate macos/Resources/AppIcon.icns from the repo logo (docs/logo.svg).
# The resulting .icns is committed, so the app build (and CI) needs no SVG
# tooling — only re-run this when the logo changes. Requires rsvg-convert
# (`brew install librsvg`) and iconutil (built into macOS).
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$MACOS_DIR/.." && pwd)"
SVG="$REPO_DIR/docs/logo.svg"
OUT="$MACOS_DIR/Resources/AppIcon.icns"
WORK="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$WORK" "$MACOS_DIR/Resources"

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)" >&2; exit 1; }

render() { rsvg-convert -w "$1" -h "$1" "$SVG" -o "$WORK/$2"; }
render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil -c icns "$WORK" -o "$OUT"
echo "✓ wrote $OUT"
