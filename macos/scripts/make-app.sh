#!/usr/bin/env bash
# Assemble Switchboard.app from the SwiftPM build output.
#
# SwiftPM only emits a bare executable, so we hand-build the .app bundle:
# Contents/MacOS/<binary> + Info.plist (LSUIElement) + an embedded Node runtime
# under Contents/Resources/runtime plus Sparkle.framework, then codesign it.
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
BUILD_VERSION="${BUILD_VERSION:-$VERSION}"
BUNDLE_ID="${BUNDLE_ID:-org.lfkdsk.switchboard}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"

case "${APPCAST_ARCH:-$(uname -m)}" in
  arm64) APPCAST_ARCH="arm64" ;;
  x64|x86_64) APPCAST_ARCH="x64" ;;
  *) echo "unsupported APPCAST_ARCH: ${APPCAST_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac

# CFBundleVersion is Sparkle's ordering key. Accept Apple's numeric build format
# plus its documented development suffixes (d/a/b/fc + 1...255).
if [[ ! "$BUILD_VERSION" =~ ^[0-9]{1,4}(\.[0-9]{1,2}){0,2}((d|a|b|fc)([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]))?$ ]]; then
  echo "invalid CFBundleVersion: $BUILD_VERSION" >&2
  exit 1
fi
if [ -n "$SPARKLE_PUBLIC_ED_KEY" ] && [[ ! "$SPARKLE_PUBLIC_ED_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "SPARKLE_PUBLIC_ED_KEY must be a 32-byte base64 Ed25519 public key" >&2
  exit 1
fi
if [ -n "${REQUIRE_SPARKLE:-}" ] && [ -z "$SPARKLE_PUBLIC_ED_KEY" ]; then
  echo "SPARKLE_PUBLIC_ED_KEY is required for a release build" >&2
  exit 1
fi

echo "▸ swift build -c $CONFIG"
( cd "$MACOS_DIR" && swift build -c "$CONFIG" )
BIN="$MACOS_DIR/.build/$CONFIG/Switchboard"
[ -x "$BIN" ] || { echo "build produced no binary at $BIN" >&2; exit 1; }

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN" "$APP/Contents/MacOS/Switchboard"

echo "▸ embedding Sparkle.framework"
SPARKLE_SOURCE="$(find "$MACOS_DIR/.build/artifacts" -type d \
  -path '*/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework' -print -quit)"
[ -n "$SPARKLE_SOURCE" ] || { echo "could not locate SwiftPM Sparkle.framework" >&2; exit 1; }
ditto "$SPARKLE_SOURCE" "$APP/Contents/Frameworks/Sparkle.framework"

# SwiftPM adds a build-tree rpath for `swift run`; the assembled bundle also
# needs the conventional self-contained Frameworks lookup.
if ! otool -l "$APP/Contents/MacOS/Switchboard" \
    | grep -Fq 'path @executable_path/../Frameworks '; then
  install_name_tool -add_rpath '@executable_path/../Frameworks' \
    "$APP/Contents/MacOS/Switchboard"
fi
otool -L "$APP/Contents/MacOS/Switchboard" \
  | grep -Fq '@rpath/Sparkle.framework/' \
  || { echo "Switchboard binary is not linked to Sparkle.framework" >&2; exit 1; }

# App icon (committed; regenerate from the logo with scripts/make-icon.sh).
ICON_PLIST=""
if [ -f "$MACOS_DIR/Resources/AppIcon.icns" ]; then
  cp "$MACOS_DIR/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  ICON_PLIST="  <key>CFBundleIconFile</key><string>AppIcon</string>"
fi

SPARKLE_PLIST=""
if [ -n "$SPARKLE_PUBLIC_ED_KEY" ]; then
  SPARKLE_PLIST="$(cat <<PLIST
  <key>SUFeedURL</key><string>https://github.com/lfkdsk/Switchboard/releases/latest/download/appcast-$APPCAST_ARCH.xml</string>
  <key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_ED_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUAutomaticallyUpdate</key><true/>
  <key>SUAllowsAutomaticUpdates</key><true/>
  <key>SUScheduledCheckInterval</key><real>21600</real>
PLIST
)"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Switchboard</string>
  <key>CFBundleDisplayName</key><string>Switchboard</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$BUILD_VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Switchboard</string>
$ICON_PLIST
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
$SPARKLE_PLIST
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

if [ "$SIGN_ID" = "-" ]; then
  # Dev builds never meet Gatekeeper, so ad-hoc is fine and --deep is tolerable.
  codesign --force --deep --sign - "$APP"
else
  # Release builds have to survive notarization: every Mach-O in the bundle needs
  # its own hardened-runtime signature and a secure timestamp. --deep is the
  # wrong tool — it walks a fixed set of locations, misses the node-pty
  # prebuilds, and smears one entitlement set over everything. Sign inside-out
  # instead: nested code first, bundle last, because sealing the bundle would
  # otherwise invalidate anything signed after it.
  ENTS="$MACOS_DIR/Resources/node.entitlements"
  NODE="$APP/Contents/Resources/runtime/bin/node"
  signed=0

  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q Mach-O || continue

    # Only Node needs the JIT entitlements; pty.node and spawn-helper just need
    # to be signed and hardened.
    if [ "$f" = "$NODE" ]; then
      codesign --force --timestamp --options runtime \
        --entitlements "$ENTS" --sign "$SIGN_ID" "$f"
    else
      codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$f"
    fi
    echo "    signed ${f#"$APP/Contents/"}"
    signed=$((signed + 1))
  done < <(find "$APP/Contents/Resources" -type f -print0)

  # The embedded runtime is the whole point of this bundle. An empty sweep means
  # the layout moved and we are one step from shipping an unsigned Node.
  [ "$signed" -ge 2 ] || { echo "expected nested Mach-O binaries, signed $signed" >&2; exit 1; }

  # Sparkle is a nested bundle hierarchy. Re-sign exactly in the order its
  # distribution guide specifies so each outer seal includes finalized inner
  # helpers. Downloader keeps its shipped entitlements; Node's JIT entitlement
  # remains confined to the runtime binary above.
  SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
  SPARKLE_VERSION="$SPARKLE/Versions/B"
  for required in \
    "$SPARKLE_VERSION/Autoupdate" \
    "$SPARKLE_VERSION/Updater.app" \
    "$SPARKLE_VERSION/XPCServices/Installer.xpc" \
    "$SPARKLE_VERSION/XPCServices/Downloader.xpc"; do
    [ -e "$required" ] || { echo "missing Sparkle helper: $required" >&2; exit 1; }
  done
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" \
    "$SPARKLE_VERSION/XPCServices/Installer.xpc"
  codesign --force --timestamp --options runtime --preserve-metadata=entitlements \
    --sign "$SIGN_ID" "$SPARKLE_VERSION/XPCServices/Downloader.xpc"
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" \
    "$SPARKLE_VERSION/Autoupdate"
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" \
    "$SPARKLE_VERSION/Updater.app"
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$SPARKLE"

  # Sealing the bundle signs Contents/MacOS/Switchboard along with it.
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --deep --verbose=2 "$APP"
fi

echo "✓ built $APP"
echo "  open it with:  open \"$APP\""
