#!/usr/bin/env bash
# Build the embedded Node runtime that ships inside Switchboard.app:
#   <dest>/bin/node      a Node binary (universal if NODE_UNIVERSAL=1)
#   <dest>/cli/          the daemon sources + production node_modules
#
# A GUI app launches with a minimal PATH and can't rely on the user's nvm/brew
# Node, so we bundle our own.
#
# Usage:  scripts/fetch-runtime.sh <dest-dir>
#
# Env:
#   NODE_VERSION=v20.18.0   Node release to fetch
#   NODE_UNIVERSAL=1        lipo arm64+x64 Node into a universal binary
#
# NOTE on node-pty: its native addon is built for the HOST arch by `npm install`.
# The Node binary can be universal, but for a truly universal app you must also
# stage node-pty's prebuild for the other arch. Single-arch (host) is the default
# and is correct for running on the machine that built it.
set -euo pipefail

DEST="${1:?usage: fetch-runtime.sh <dest-dir>}"
MACOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$MACOS_DIR/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-v20.18.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch_node() { # <arch> -> echoes path to extracted node binary
  local arch="$1"
  local tarball="node-$NODE_VERSION-darwin-$arch"
  local url="https://nodejs.org/dist/$NODE_VERSION/$tarball.tar.gz"
  echo "  ↓ $url" >&2
  curl -fsSL "$url" -o "$WORK/$tarball.tar.gz"
  tar -xzf "$WORK/$tarball.tar.gz" -C "$WORK"
  echo "$WORK/$tarball/bin/node"
}

mkdir -p "$DEST/bin" "$DEST/cli"

HOST_ARCH="$(uname -m)"   # arm64 | x86_64
case "$HOST_ARCH" in
  arm64) NODE_HOST=arm64 ;;
  x86_64) NODE_HOST=x64 ;;
  *) echo "unsupported arch $HOST_ARCH" >&2; exit 1 ;;
esac

if [ -n "${NODE_UNIVERSAL:-}" ]; then
  ARM="$(fetch_node arm64)"
  X64="$(fetch_node x64)"
  lipo -create "$ARM" "$X64" -output "$DEST/bin/node"
  echo "  built universal node" >&2
else
  HOSTBIN="$(fetch_node "$NODE_HOST")"
  cp "$HOSTBIN" "$DEST/bin/node"
fi
chmod +x "$DEST/bin/node"

# Stage the daemon sources and install production deps with the bundled Node.
cp "$REPO_DIR/cli/index.js" "$DEST/cli/"
cp "$REPO_DIR/cli/package.json" "$DEST/cli/"
cp -R "$REPO_DIR/cli/scripts" "$DEST/cli/"

echo "  installing cli production deps" >&2
( cd "$DEST/cli" && PATH="$DEST/bin:$PATH" npm install --omit=dev --no-audit --no-fund )

# Re-assert node-pty's spawn-helper +x bit (its postinstall already does this,
# but belt-and-suspenders for the bundled copy).
( cd "$DEST/cli" && PATH="$DEST/bin:$PATH" node scripts/fix-pty-perms.js || true )

echo "✓ runtime staged at $DEST"
