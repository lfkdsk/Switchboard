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
- **Settings → "Let my other machines run commands here"** is this app's
  `SWITCHBOARD_PEER`. A GUI app inherits launchd's environment rather than your
  shell's, so the env var isn't reachable here — the toggle is how a Mac declines
  `switchboard exec` from the rest of your account. On by default, like the CLI.
- **Settings → Open Full Disk Access settings…** grants the app-level privacy
  permission inherited by browser and peer shells, so unattended commands can
  reach protected folders such as Desktop, Documents, and Downloads.
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
The updater also reasserts `index.js` mode `0755` before activating it, because
the installed `switchboard` executable may be a symlink to that file.

Guardrails:

- An update whose `dependencies` differ from the bundled package's is refused
  and points to **Check for App Updates** — dependency changes ride the signed
  app/DMG release train.
- If a hot-updated daemon dies twice within 20 s of starting, the update is
  dropped and the bundled cli takes the next restart (`updater.log` records it).
- After a DMG upgrade whose bundled cli is ≥ the staged version, the stale
  staging is pruned automatically.

Headless check (same code path as the menu button):

```bash
build/Switchboard.app/Contents/MacOS/Switchboard --update-check
```

Logs: `~/Library/Logs/Switchboard/updater.log`.

## App updates (Sparkle)

Signed release builds use Sparkle 2 to check for a new `Switchboard.app` every
six hours, download it in the background, verify its Ed25519 signature, and
install it only after Switchboard is idle. This is separate from the cli hot
updater above: the main menu says **Check for App Updates…**, while the Settings
action says **Check for cli hot updates**.

An automatic restart is allowed only when all three read-only activity signals
are available and zero:

1. descendants of the supervised daemon process;
2. PTY holder sockets under `~/.switchboard/sessions/`; and
3. JobStore records under `~/.switchboard/jobs/` whose status is `running`.

The check fails closed: an unreadable directory, malformed job record, missing
`ps` result, or any other unknown signal postpones installation. After an idle
preflight, the app briefly pauses the daemon, repeats the complete check, and
only stops it if the frozen recheck is still idle. This closes the race where a
new shell or detached job could start between checking and restarting. A stale
holder socket or stale `running` record can therefore delay an automatic update
even when no work remains; use **Restart and Update…** after confirming that it
is safe. That explicit action warns that running detached jobs may be stopped.

Sparkle normally installs a downloaded update whenever its host app quits.
Switchboard also gates that path: an ordinary Quit is postponed while a pending
update has not passed the idle check. The app exits only after the automatic
gate succeeds or the user explicitly confirms **Restart and Update…**.

Development/ad-hoc builds without `SUFeedURL` and `SUPublicEDKey` keep app
updates disabled. Existing installations at **0.6.1 or older do not contain
Sparkle** and must install one new DMG manually from the GitHub Releases page;
all later signed releases can update themselves.

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

# A release-style local build also injects its architecture feed and public key.
VERSION=0.7.0 BUILD_VERSION=0.7.0 APPCAST_ARCH=arm64 \
SPARKLE_PUBLIC_ED_KEY='<base64 public key>' REQUIRE_SPARKLE=1 \
SIGN_ID="Developer ID Application: …" scripts/make-app.sh
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
  best-effort `--selftest` smoke (non-gating), and uploads an architecture-specific
  `Switchboard-<version>-<arch>.dmg` workflow artifact. Non-tag builds remain
  ad-hoc signed and have app updates disabled.
- A stable **`vMAJOR.MINOR.PATCH` tag** signs and notarizes the app and DMG,
  generates Ed25519-signed `appcast-arm64.xml` and `appcast-x64.xml`, then
  publishes all four files in one GitHub Release. Sparkle compares the
  monotonic `CFBundleVersion`; `scripts/version-info.sh` maps prereleases such
  as `v1.2.3-rc2` to Apple's ordered `1.2.3fc2` form.
- Suffixed tags are never production feeds. `-rcN` releases remain drafts and
  all `-alphaN`, `-betaN`, and `-rcN` tags are marked prerelease. GitHub's
  anonymous `releases/latest/download/` URL therefore continues to resolve to
  the latest stable appcasts.

Release feeds are split by architecture:

- `https://github.com/lfkdsk/Switchboard/releases/latest/download/appcast-arm64.xml`
- `https://github.com/lfkdsk/Switchboard/releases/latest/download/appcast-x64.xml`

### Sparkle signing key setup

Do this once on a trusted Mac. Sparkle's `generate_keys` stores the private key
in the login Keychain; use a dedicated account label so the key is easy to
identify. Never commit the exported private key or place it inside this repo.

```bash
cd macos
swift package resolve
GENERATE_KEYS="$(find .build/artifacts -type f \
  -path '*/Sparkle/bin/generate_keys' -print -quit)"
test -x "$GENERATE_KEYS"

# Generate once (or print the existing key for this account).
"$GENERATE_KEYS" --account org.lfkdsk.switchboard
PUBLIC_KEY="$("$GENERATE_KEYS" --account org.lfkdsk.switchboard -p)"

# Export to a protected file only long enough to store/back up the secret.
umask 077
"$GENERATE_KEYS" --account org.lfkdsk.switchboard \
  -x "$TMPDIR/switchboard-sparkle-private-key"
```

The repository administrator must then configure:

- GitHub Actions secret **`SPARKLE_ED_PRIVATE_KEY`** with the exact contents of
  `switchboard-sparkle-private-key`;
- GitHub Actions repository variable **`SPARKLE_ED_PUBLIC_KEY`** with
  `$PUBLIC_KEY`.

For an authenticated repository administrator using GitHub CLI:

```bash
gh secret set SPARKLE_ED_PRIVATE_KEY \
  < "$TMPDIR/switchboard-sparkle-private-key"
gh variable set SPARKLE_ED_PUBLIC_KEY --body "$PUBLIC_KEY"
```

Keep an offline backup of the private key, remove the temporary export after
the secret and backup are verified, and retain the same key for future releases:
already-installed apps pin its public half. The workflow fails a tag build
before packaging if either value is missing; branch and pull-request builds do
not require either value.

### Release checklist

1. Confirm the tag is exactly `vMAJOR.MINOR.PATCH` for production (or one of
   `-alphaN`, `-betaN`, `-rcN` for prerelease validation).
2. Push the tag and wait for both architecture jobs, Developer ID signing,
   notarization/stapling, appcast signing, and the single Release job to pass.
3. For a stable release, confirm the Release is neither draft nor prerelease and
   that both DMGs and both appcasts are present.
4. Verify each feed anonymously, for example:

   ```bash
   curl -fL -o /tmp/appcast-arm64.xml \
     https://github.com/lfkdsk/Switchboard/releases/latest/download/appcast-arm64.xml
   xmllint --noout /tmp/appcast-arm64.xml
   grep -F 'sparkle:edSignature=' /tmp/appcast-arm64.xml
   ```

The tag job requires the existing Apple Developer ID/notarization secrets as
well as the two Sparkle values. It signs nested Node binaries and Sparkle's
Autoupdate, Updater app, and XPC services from the inside out before sealing the
outer app; the Node JIT entitlements remain scoped to the embedded Node binary.

### Distribution (notarization)

Ad-hoc signing (`-`) is fine for local development. Tag builds use a Developer
ID, the hardened runtime, and Apple notarization for both the app and DMG.
Node's JIT needs the `com.apple.security.cs.allow-jit` /
`com.apple.security.cs.allow-unsigned-executable-memory` entitlements under the
hardened runtime; do not apply those entitlements to Sparkle helpers or the
outer app.

## Layout

| Path | What it is |
| --- | --- |
| `Package.swift` | SwiftPM executable (macOS 13+, Swift 5 language mode) |
| `Sources/Switchboard/SwitchboardApp.swift` | `@main`, MenuBarExtra scene, accessory policy, auto-start |
| `Sources/Switchboard/DaemonSupervisor.swift` | spawn/restart the daemon, parse NDJSON, exit-code handling |
| `Sources/Switchboard/AppUpdater.swift` | Sparkle app updates, gentle reminders, idle-gated installation |
| `Sources/Switchboard/MenuContent.swift` | the menu UI |
| `Sources/Switchboard/StatusEvent.swift` | NDJSON event model + connection state |
| `Sources/Switchboard/NodeRuntime.swift` | locate bundled vs dev Node + cli (hot update aware) |
| `Sources/Switchboard/DaemonUpdater.swift` | hot-update the cli from npm (verify, stage, rollback) |
| `Sources/UpdatePolicy/UpdateInstallPolicy.swift` | portable fail-closed activity policy and probes |
| `Sources/Switchboard/Prefs.swift` | server/shell prefs + launch-at-login |
| `Sources/Switchboard/ConfigReader.swift` | read `~/.switchboard/config.json` |
| `Sources/Switchboard/SelfTest.swift` | headless `--selftest` verification |
| `Resources/AppIcon.svg` | the logo on Apple's icon grid (margin + shadow) |
| `Resources/AppIcon.icns` | app icon, generated from `AppIcon.svg` (committed) |
| `scripts/make-app.sh` | assemble + sign `Switchboard.app` |
| `scripts/version-info.sh` | map release tags to monotonic Apple bundle versions |
| `scripts/fetch-runtime.sh` | stage the embedded Node runtime |
| `scripts/make-icon.sh` | regenerate `AppIcon.icns` from `AppIcon.svg` (needs `librsvg`) |
| `run-dev.sh` | run from source against the repo cli |
