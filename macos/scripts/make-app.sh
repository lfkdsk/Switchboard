#!/usr/bin/env bash
# Assemble Switchboard.app from the SwiftPM build output.
#
# SwiftPM only emits a bare executable, so we hand-build the .app bundle:
# Contents/MacOS/<binary> + Info.plist (LSUIElement) + an embedded Node runtime
# under Contents/Resources/runtime, then ad-hoc codesign it.
#
# Usage:
#   scripts/make-app.sh                 # release build, embed runtime, sign
#   CONFIG=debug scripts/make-app.sh    # debug build
#   SKIP_RUNTIME=1 scripts/make-app.sh  # skip embedding Node (dev: uses env/PATH)
#   SIGN_ID="Developer ID Application: …" scripts/make-app.sh   # real signing
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$MACOS_DIR/.." && pwd)"
CONFIG="${CONFIG:-release}"
APP="$MACOS_DIR/build/Switchboard.app"
VERSION="${VERSION:-0.1.0}"
BUNDLE_ID="${BUNDLE_ID:-org.lfkdsk.switchboard}"

echo "▸ swift build -c $CONFIG"
( cd "$MACOS_DIR" && swift build -c "$CONFIG" )
BIN="$MACOS_DIR/.build/$CONFIG/Switchboard"
[ -x "$BIN" ] || { echo "build produced no binary at $BIN" >&2; exit 1; }

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Switchboard"

# App icon (committed; regenerate from the logo with scripts/make-icon.sh).
ICON_PLIST=""
if [ -f "$MACOS_DIR/Resources/AppIcon.icns" ]; then
  cp "$MACOS_DIR/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  ICON_PLIST="  <key>CFBundleIconFile</key><string>AppIcon</string>"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Switchboard</string>
  <key>CFBundleDisplayName</key><string>Switchboard</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Switchboard</string>
$ICON_PLIST
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ -z "${SKIP_RUNTIME:-}" ]; then
  echo "▸ embedding Node runtime"
  "$MACOS_DIR/scripts/fetch-runtime.sh" "$APP/Contents/Resources/runtime"
else
  echo "▸ SKIP_RUNTIME set — app will fall back to env/PATH Node (dev only)"
fi

SIGN_ID="${SIGN_ID:--}"   # default to ad-hoc ("-")
echo "▸ codesign ($SIGN_ID)"
codesign --force --deep --sign "$SIGN_ID" "$APP"

echo "✓ built $APP"
echo "  open it with:  open \"$APP\""
