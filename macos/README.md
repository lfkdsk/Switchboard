# Switchboard menu-bar app (macOS)

A native macOS menu-bar app that keeps Switchboard running in the background, so
your machine stays reachable without leaving a terminal window open. It doesn't
reimplement the daemon — it **supervises** the existing `cli/` Node daemon as a
child process and reflects its live status in the menu bar.

```
Switchboard.app  (LSUIElement — menu bar only, no Dock icon)
  └─ MenuBarExtra UI ── status dot · RTT/CPU/Mem · Open dashboard · Start/Stop
        │ spawns + supervises, reads NDJSON status
  └─ embedded Node runtime ── cli/index.js  ── wss ─▶ relay
```

- **No Dock icon, no ⌘-Tab entry** — it lives only in the menu bar (`LSUIElement`).
- **Launch at login** via `SMAppService` (macOS 13+).
- **Self-contained** — bundles its own Node, so it doesn't depend on the user's
  `nvm`/`brew` Node being on a GUI process's minimal `PATH`.
- Auto-starts the daemon on login **only when you're signed in** (an anonymous
  token nobody has seen is useless on a silent launch; token mode waits for an
  explicit *Start*).

## How status flows

The daemon (`cli/index.js`) emits one JSON object per line on each lifecycle
event when `SWITCHBOARD_STATUS_FILE` (or `SWITCHBOARD_JSON_STATUS=1` → fd 3) is
set — `connecting`, `connected`, `ready`, `stats`, `peer`, `disconnected`,
`fatal`, `stopping`. The app passes a temp `SWITCHBOARD_STATUS_FILE`, tails it,
and drives the menu state machine. Human-readable logs still go to
`~/Library/Logs/Switchboard/daemon.log`. This is opt-in and inert for normal CLI
use.

## Hot updates (cli)

The JS daemon can update itself from npm without a new DMG. `DaemonUpdater`
checks `registry.npmjs.org` for `@switch-board/cli` (on launch, every 6 h, and
from **Settings → Check for cli updates**), verifies the tarball against the
registry's sha512 SSRI, and stages it under
`~/Library/Application Support/Switchboard/cli-updates/<version>/`. When a
staged version is newer than the bundled one, the supervisor runs its
`index.js` — still on the **bundled** Node and the **bundled** `node_modules`
(via a `node_modules` symlink into the staged dir, `NODE_PATH` as fallback), so
native code (node-pty) never changes outside a signed release.

Guardrails:

- An update whose `dependencies` differ from the bundled package's is refused
  (`needs a new app build`) — dep changes ride the DMG train.
- If a hot-updated daemon dies twice within 20 s of starting, the update is
  dropped and the bundled cli takes the next restart (`updater.log` records it).
- After a DMG upgrade whose bundled cli is ≥ the staged version, the stale
  staging is pruned automatically.

Headless check (same code path as the menu button):

```bash
build/Switchboard.app/Contents/MacOS/Switchboard --update-check
```

Logs: `~/Library/Logs/Switchboard/updater.log`.

## Develop

```bash
cd macos
./run-dev.sh                 # runs from source against ../cli using your PATH Node
```

A menu-bar icon appears top-right; quit from the menu's **Quit** button.

Headless check of the supervisor↔daemon wiring (no GUI):

```bash
swift build
SWITCHBOARD_NODE="$(command -v node)" SWITCHBOARD_CLI="$(cd ../cli && pwd)/index.js" \
  ./.build/debug/Switchboard --selftest
# prints state transitions and exits 0 once it reaches Online
```

## Build the app bundle

```bash
cd macos
scripts/make-app.sh                 # release build + embedded Node + ad-hoc sign
open build/Switchboard.app

# variants
SKIP_RUNTIME=1 scripts/make-app.sh  # skip embedding Node (dev; uses env/PATH)
NODE_UNIVERSAL=1 scripts/make-app.sh # universal Node binary (see caveat below)
SIGN_ID="Developer ID Application: …" scripts/make-app.sh  # real signing
```

Move `build/Switchboard.app` to `/Applications` for a permanent install; the
**Launch at login** toggle then registers it with the system.

### Architecture / universal caveat

`scripts/fetch-runtime.sh` fetches the Node binary (universal via `lipo` when
`NODE_UNIVERSAL=1`) and runs `npm install --omit=dev` for the cli. node-pty's
native addon is built for the **host** arch only, so a default build runs on the
machine that built it. A truly universal app additionally needs node-pty's
prebuild staged for the other arch — left as a follow-up.

## Continuous integration & releases

[`.github/workflows/macos-app.yml`](../.github/workflows/macos-app.yml) builds the
app on every push/PR and packages it:

- A matrix builds on **`macos-14` (arm64)** and **`macos-15-intel` (x64)**, each
  embedding the matching-arch Node + node-pty, so every DMG is self-contained for
  its architecture (sidesteps the universal node-pty problem above).
- Each build verifies the bundle (codesign, `LSUIElement`, embedded Node), runs a
  best-effort `--selftest` smoke (non-gating), and uploads
  `Switchboard-<version>-<arch>.dmg` as a workflow artifact.
- Pushing a **`v*` tag** (e.g. `git tag v0.1.0 && git push --tags`) additionally
  publishes a GitHub Release with both DMGs attached and auto-generated notes.

The DMGs are **ad-hoc signed**, so on first launch users must right-click →
**Open** (or `xattr -dr com.apple.quarantine Switchboard.app`) to get past
Gatekeeper. Notarize (below) to remove that step.

### Distribution (notarization)

Ad-hoc signing (`-`) is fine for personal use. To distribute: sign with a
Developer ID, enable the hardened runtime, and notarize. Node's JIT needs the
`com.apple.security.cs.allow-jit` /
`com.apple.security.cs.allow-unsigned-executable-memory` entitlements under the
hardened runtime.

## Layout

| Path | What it is |
| --- | --- |
| `Package.swift` | SwiftPM executable (macOS 13+, Swift 5 language mode) |
| `Sources/Switchboard/SwitchboardApp.swift` | `@main`, MenuBarExtra scene, accessory policy, auto-start |
| `Sources/Switchboard/DaemonSupervisor.swift` | spawn/restart the daemon, parse NDJSON, exit-code handling |
| `Sources/Switchboard/MenuContent.swift` | the menu UI |
| `Sources/Switchboard/StatusEvent.swift` | NDJSON event model + connection state |
| `Sources/Switchboard/NodeRuntime.swift` | locate bundled vs dev Node + cli (hot update aware) |
| `Sources/Switchboard/DaemonUpdater.swift` | hot-update the cli from npm (verify, stage, rollback) |
| `Sources/Switchboard/Prefs.swift` | server/shell prefs + launch-at-login |
| `Sources/Switchboard/ConfigReader.swift` | read `~/.switchboard/config.json` |
| `Sources/Switchboard/SelfTest.swift` | headless `--selftest` verification |
| `Resources/AppIcon.svg` | the logo on Apple's icon grid (margin + shadow) |
| `Resources/AppIcon.icns` | app icon, generated from `AppIcon.svg` (committed) |
| `scripts/make-app.sh` | assemble + sign `Switchboard.app` |
| `scripts/fetch-runtime.sh` | stage the embedded Node runtime |
| `scripts/make-icon.sh` | regenerate `AppIcon.icns` from `AppIcon.svg` (needs `librsvg`) |
| `run-dev.sh` | run from source against the repo cli |
