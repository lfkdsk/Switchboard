#!/usr/bin/env bash
# Run the menu-bar app from source against the repo's cli/, using your PATH Node.
# A menu-bar icon appears in the top-right; quit it from the menu's Quit button.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export SWITCHBOARD_NODE="${SWITCHBOARD_NODE:-$(command -v node)}"
export SWITCHBOARD_CLI="${SWITCHBOARD_CLI:-$(cd "$HERE/../cli" && pwd)/index.js}"
[ -d "$HERE/../cli/node_modules" ] || ( cd "$HERE/../cli" && npm install )
echo "node=$SWITCHBOARD_NODE"
echo "cli=$SWITCHBOARD_CLI"
( cd "$HERE" && swift run Switchboard "$@" )
