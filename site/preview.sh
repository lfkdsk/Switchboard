#!/usr/bin/env bash
# Preview the landing page exactly as GitHub Pages will serve it.
#
#   site/preview.sh            → http://localhost:8000
#   site/preview.sh 4321       → http://localhost:4321
#
# The screenshots live in docs/ (the README links to them there), so this
# stages the same _site tree the Pages workflow builds rather than keeping
# a second copy of the images in site/assets/.
set -euo pipefail

port="${1:-8000}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
out="$repo/_site"

rm -rf "$out"
mkdir -p "$out"
cp -R "$here"/. "$out"/
rm -f "$out/preview.sh"
cp "$repo/docs/terminal.png" "$repo/docs/dashboard.png" "$out/assets/"

echo "→ http://localhost:$port"
exec python3 -m http.server "$port" --directory "$out"
