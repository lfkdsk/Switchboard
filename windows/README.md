# Switchboard tray app (Windows)

A Windows notification-area app that keeps Switchboard running in the
background, so your PC stays reachable without leaving a terminal window open.
It is the Windows counterpart of the [macOS menu-bar app](../macos/README.md):
it doesn't reimplement the daemon — it **supervises** the existing `cli/` Node
daemon as a child process and reflects its live status in the tray.

```
Switchboard.exe  (WinForms, tray only — no main window)
  └─ NotifyIcon menu ── status dot · RTT/CPU/Mem · Open dashboard · Start/Stop
        │ spawns + supervises, reads NDJSON status
  └─ runtime\node.exe ── runtime\cli\index.js ── wss ─▶ relay
```

- **Tray only.** Left or right click the icon for the menu; the icon carries a
  status dot (green online, yellow connecting, red needs you).
- **Start when I sign in** — an `HKCU\…\Run` entry, set by the installer (on by
  default) and toggled from **Settings…**.
- **Settings → "Let my other machines run commands here"** is this app's
  `SWITCHBOARD_PEER`. On by default, like the CLI.
- **Self-contained** — bundles its own Node and node-pty, so it doesn't depend
  on a Node on `PATH`. The app itself targets .NET Framework 4.8, which every
  supported Windows 10/11 already has.
- Auto-starts the daemon **only when you're signed in** (an anonymous token
  nobody has seen is useless on a silent launch; token mode waits for an
  explicit *Start*).
- Default shell is `powershell.exe`; set another (`pwsh.exe`, `cmd.exe`, Git
  Bash…) in Settings.

## Install

Grab `Switchboard-<version>-x64-setup.exe` from the
[Releases](https://github.com/lfkdsk/Switchboard/releases) page. It installs
per-user into `%LOCALAPPDATA%\Programs\Switchboard` — no admin prompt — and
adds a Start menu entry. `Switchboard-<version>-x64.zip` is the same app as a
portable folder: unzip anywhere and run `Switchboard.exe`.

The builds are **not code-signed** yet, so SmartScreen shows *Windows protected
your PC* on first run: **More info → Run anyway**.

Requires Windows 10 1809 or later (ConPTY). On Windows on Arm the x64 build runs
under emulation.

## How it differs from macOS under the hood

Status flows the same way — the app passes a temp `SWITCHBOARD_STATUS_FILE` and
tails the NDJSON the daemon appends (`connecting`, `connected`, `ready`,
`stats`, `peer`, `disconnected`, `fatal`, `stopping`).

**Stopping** is the one real difference. A windowless child on Windows can't be
sent SIGINT/SIGTERM (`kill()` there is `TerminateProcess`, which would orphan
the shells), so the app starts the daemon with
`SWITCHBOARD_STOP_ON_STDIN_EOF=1` and holds its stdin open; **Stop** closes it,
and the daemon runs the same clean shutdown it does on SIGTERM. If the app
itself dies, the pipe closes and the daemon follows it. A daemon that hasn't
exited 5 s after being asked has its process tree killed.

Paths:

| What | Where |
| --- | --- |
| Daemon log (rotated at 5 MB) | `%LOCALAPPDATA%\Switchboard\Logs\daemon.log` |
| Updater log | `%LOCALAPPDATA%\Switchboard\Logs\updater.log` |
| Hot-updated cli | `%LOCALAPPDATA%\Switchboard\cli-updates\<version>\` |
| Preferences | `HKCU\Software\Switchboard` |
| Account (shared with the CLI) | `%USERPROFILE%\.switchboard\config.json` |

**Open logs folder** in the menu goes straight to the first two.

## Hot updates (cli)

Same design as macOS: the JS daemon updates itself from npm without a new
installer. The updater checks `registry.npmjs.org` for `@switch-board/cli` (on
launch, every 6 h, and from **Check for cli updates**), verifies the tarball
against the registry's sha512 SSRI, extracts it with the `tar.exe` that ships
with Windows, and stages it under `cli-updates\<version>\`. The staged
`index.js` still runs on the **bundled** `node.exe` and the **bundled**
`node_modules` (through a directory junction — no admin or Developer Mode
needed — with `NODE_PATH` as a fallback), so native code never changes outside
a release. The same guardrails apply: an update whose `dependencies` differ is
refused, a hot-updated daemon that dies twice within 20 s is rolled back, and
staging older than the bundled cli is pruned after an upgrade.

Headless check (same code path as the menu item):

```powershell
Switchboard.exe --update-check   # result in Logs\selftest.log and on stderr
```

## Develop

Needs the .NET SDK (8 or later), Node on `PATH`, and `npm install` run once in
`cli\`.

```powershell
cd windows
dotnet build                     # bin\Debug\net48\Switchboard.exe
bin\Debug\net48\Switchboard.exe  # uses node on PATH + ..\cli\index.js
```

(`dotnet build` also works on Linux/macOS for a compile check — the .NET
Framework reference assemblies come from NuGet.)

Headless check of the supervisor↔daemon wiring, no tray:

```powershell
$env:SELFTEST_SECONDS = 12
bin\Debug\net48\Switchboard.exe --selftest
Get-Content $env:LOCALAPPDATA\Switchboard\Logs\selftest.log -Tail 10
# PASS once it reached Online and the stop was graceful
```

`SELFTEST_EXPECT=connecting` plus `SWITCHBOARD_SERVER=http://127.0.0.1:9` runs
the same test offline: it passes once the daemon is dialing and then stops
cleanly when asked.

## Build the app

```powershell
cd windows
scripts\make-app.ps1                    # release build + embedded Node -> build\Switchboard\
scripts\make-app.ps1 -Version 1.2.3     # stamp a version
scripts\make-app.ps1 -SkipRuntime       # dev: falls back to env/PATH Node
iscc /DAppVersion=1.2.3 installer\Switchboard.iss   # -> build\Switchboard-1.2.3-x64-setup.exe
```

`scripts\fetch-runtime.ps1` downloads the official Node zip (checked against
the release's `SHASUMS256.txt`), stages the cli from `npm pack` exactly as
published, and runs `npm install --omit=dev` with that Node so node-pty matches
it.

## Continuous integration & releases

[`.github/workflows/windows-app.yml`](../.github/workflows/windows-app.yml)
builds on every push/PR on `windows-latest`:

- builds the app with the embedded Node x64 + node-pty, checks the bundle, and
  proves the shipped node-pty can open a ConPTY (`scripts/check-pty.js`);
- runs `--selftest` offline (**gating** — state machine + graceful stop) and
  against the public relay (non-gating);
- builds the Inno Setup installer and the portable zip, then installs and
  uninstalls silently to check what lands and what's cleaned up;
- uploads both as the `Switchboard-windows-x64` artifact.

Pushing a **`v*` tag** additionally attaches both to the GitHub Release — the
same Release the macOS workflow attaches its DMGs to, with the same
draft/prerelease rules (`-rc` tags stay drafts).

## Layout

| Path | What it is |
| --- | --- |
| `Switchboard.csproj` | SDK-style WinExe project (.NET Framework 4.8) |
| `src/Program.cs` | entry point, single-instance mutex, `--selftest` / `--update-check` |
| `src/TrayApp.cs` | the notification-area icon and its menu |
| `src/DaemonSupervisor.cs` | spawn/stop/restart the daemon, parse NDJSON, logs |
| `src/StatusEvent.cs` | NDJSON event model + connection state |
| `src/NodeRuntime.cs` | locate bundled vs dev Node + cli (hot update aware) |
| `src/DaemonUpdater.cs` | hot-update the cli from npm (verify, stage, rollback) |
| `src/Prefs.cs` | relay/shell/peer prefs + launch at sign-in |
| `src/SettingsForm.cs` | the Settings window |
| `src/ConfigReader.cs` | read `~/.switchboard/config.json` |
| `src/SelfTest.cs` | headless `--selftest` verification |
| `Resources/Switchboard.ico` | app + tray icon, generated from `docs/logo.svg` (committed) |
| `scripts/make-app.ps1` | build + assemble `build\Switchboard\` |
| `scripts/fetch-runtime.ps1` | stage the embedded Node runtime |
| `scripts/check-pty.js` | CI check that the bundled node-pty opens a ConPTY |
| `scripts/make-icon.sh` | regenerate the `.ico` (needs `rsvg-convert` + ImageMagick) |
| `installer/Switchboard.iss` | per-user Inno Setup installer |
