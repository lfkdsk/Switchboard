---
name: switchboard
description: >-
  Drive the Switchboard CLI (@switch-board/cli) to work on the user's *other*
  machines: `switchboard nodes` lists them, `switchboard exec <node> <cmd>` runs
  something over there with real stdout and a real exit code, `switchboard cp`
  transfers a file, detached jobs survive caller disconnects, `switchboard shell
  <node>` opens an interactive one, and `switchboard login` / `service` expose a
  machine. Use this whenever a task belongs on a different machine than the one
  you're on — "run the tests on my build box", "what is my desktop doing?", "is
  the mac mini still up?", "get me a shell on the server", "share this box with
  someone" — or when switchboard, a relay or circuit, `~/.switchboard`, or the
  menu-bar app comes up. Also when the work needs hardware this machine hasn't
  got: a GPU, another OS, a host on a different network.
---

# Switchboard

A Switchboard daemon runs on a machine and dials *out* to a relay, so that
machine is reachable without inbound ports or a VPN. Whoever holds the right
credential — a browser, or an authorized peer machine — connects to the
relay and is patched through. One machine + one relay = one **circuit**.

Two credentials, and they behave differently:

- **Account** (`switchboard login`) — the machine is bound to the user's GitHub
  account, shows up in their dashboard, and can be shared through a ten-minute,
  single-use code redeemed by another GitHub account. Owned and shared machines
  both appear in `nodes`; peer commands
  additionally require the target's peer opt-in.
- **Token** (`switchboard`, no login) — a one-off share. Anyone holding the token
  gets a shell there. No dashboard, no peer access. Good for pairing; not a
  thing to leave running.

If the CLI isn't installed, `npx @switch-board/cli <args>` works for every
command below and is the right call for a one-off. `npm i -g @switch-board/cli`
is better for a machine you'll come back to — and required before installing the
systemd service, which needs a path npm won't evict.

## Working on another machine

Start with `switchboard nodes` (alias `ls`). It answers three things at once:
what exists, what's online, and what each box is busy with.

```
  ● build-box   3f2a9c11  18ms · cpu 41% · claude: refactor the parser (Bash)
  ● mini        7be04d2a  9ms · cpu 3% · 2 shells · vim
  ○ laptop      c1d9f0aa  offline · last seen 2h ago
  ● this-box    5aa71e33  this machine · peer off · 6ms · cpu 12%
```

`--json` gives the same list machine-readably (`id`, `name`, `shared`, `owner`,
`expiresAt`, `online`, `peer`,
`lastSeenMsAgo`, `rtt`, `cpu`, `memUsed`, `memTotal`, `platform`, `arch`, `activity`) — use it when
you need to branch on the answer rather than show it to someone.

**`exec` is the workhorse.** It's a plain command: stdout on stdout, stderr on
stderr, and the remote exit code becomes the local one, so ordinary shell logic
works across machines.

```bash
switchboard exec build-box npm test
switchboard exec build --cwd '~/src/api' -- cargo build --release
switchboard exec mini --timeout 120 ./deploy.sh
switchboard exec mini --login which xcodebuild
switchboard exec mini --shell /bin/bash 'rm -f dir/*.png && echo done'
switchboard exec build-box 'cd ~/app && git pull && npm test'   # one remote shell
echo "$patch" | switchboard exec build-box 'git apply -'        # piped stdin is forwarded
```

Everything after the machine name belongs to the far end, quoting included, so
`exec box ls -la` keeps its `-la` instead of losing it to the local parser. The
Commands are non-login by default. Add `--login` (`$SHELL -lc`) when tools
installed by a version manager — node, cargo, xcodebuild — are missing, and use
`--shell /bin/bash` to override zsh for a command whose unmatched glob should not abort.

Quote anything your local shell shouldn't touch, `--cwd` included: an unquoted
`~/app` is expanded here, to *your* home, before the far end ever sees it.

**`shell` is the browser terminal in a terminal.** Use it when the work is
genuinely interactive (a TUI, a REPL, watching a log). **Ctrl-]** detaches and
leaves the shell running as a dashboard tab; `--attach` picks the newest one back
up, and `shell <node> <sid>` reattaches to a specific one.

```bash
switchboard shell mini
switchboard shell mini --attach
```

**Naming a machine:** a hostname, a machine id, or any unambiguous prefix of
either (`switchboard exec bui npm test`). An ambiguous prefix is an error rather
than a guess — running a command on the wrong host isn't undoable.

**Exit codes.** `exec` passes the remote command's own code through unchanged, so
`&&`, `||` and `$?` mean what they usually mean. Four codes are the CLI's own,
for when there wasn't a remote one to pass on:

| Code | Meaning |
| --- | --- |
| 124 | `--timeout` expired; SIGTERM then SIGKILL went to the remote process group |
| 126 | never started — no such directory, an empty command, or the host's 8 exec slots were full |
| 130 | you pressed Ctrl-C twice and gave up locally |
| 255 | the host went offline, or the link dropped mid-command |

### exec or shell?

Prefer `exec`. It gives you clean output and a real exit code, which is what you
want to reason about; a PTY echoes your own keystrokes back and paints escape
sequences through the transcript. Reach for `shell` only when something needs a
terminal to work at all.

One caveat that decides the choice for long jobs: **an attached `exec` dies with the link
it was invoked over.** If the connection drops, the far end kills the command —
deliberately, since its output has nowhere left to go. A ten-minute build is fine;
an hour-long build should use `exec --detach`. Query it with `jobs`, stream its
bounded target-side log with `logs --follow`, and collect its status with `wait`.

`switchboard cp local node:remote` uploads one file and `switchboard cp
node:remote local` downloads one. Both directions verify SHA-256; directories are
rejected explicitly.

Also worth knowing: at most 8 `exec`s run concurrently on one host, and Ctrl-C
reaches the remote process group, so a pipeline dies the way it would locally.

## Exposing a machine

```bash
switchboard login     # sign in via browser, then serve this machine's shell
switchboard           # no account: print a one-off token + URL, serve that
switchboard logout    # drop the stored credential (machine id is kept)
```

`login` opens a browser, waits for the authorization, saves the credential to
`~/.switchboard/config.json` (mode 0600) and then *keeps running* — signing in
and exposing the shell are one step. It stays in the foreground; Ctrl-C stops it.

That's the part to be careful with: leaving `switchboard` running exposes a real
shell on that machine. In token mode the token *is* the credential — anyone who
has it gets that shell — so don't paste one into a shared log, an issue, or a
commit, and don't leave an anonymous daemon up as a convenience.

**Keeping it up** rather than living in a terminal window:

```bash
switchboard service install     # Linux: systemd --user unit + lingering, starts at boot
switchboard service status
switchboard service uninstall
```

macOS has a menu-bar app instead (see the repo's Releases) — same daemon, with a
status menu and launch-at-login.

**One daemon at a time.** Circuits are last-writer-wins: a new daemon takes the
line and the one already serving that machine is dropped, closing the shells open
in it. So a hand-started daemon asks first when something is already up:

```
! Switchboard is already running on this machine.

    Started   2h 11m ago by the menu-bar app (pid 4821)
    Serving   lfkdsk at https://shell.lfkdsk.org
...
Take over? [y/N]
```

Answer that honestly rather than reflexively — someone may be working in those
shells. `--force` (or `SWITCHBOARD_FORCE=1`) skips the question when you know
it's yours to take, and is the right flag for a script; a launch with no terminal
to ask (a unit, the app, CI) logs the takeover and proceeds.

## Environment and files

| | |
| --- | --- |
| `SWITCHBOARD_SERVER` | relay origin (`-s/--server`). Default `https://shell.lfkdsk.org` |
| `SWITCHBOARD_TOKEN` | force token mode with a fixed token (`-t/--token`, min 24 chars) |
| `SWITCHBOARD_SHELL` | shell to spawn (`--shell`). Default `$SHELL` |
| `SWITCHBOARD_PEER=0` | refuse `exec`/`shell` from peer machines (`--no-peer`) |
| `SWITCHBOARD_FORCE=1` | start without the duplicate-daemon question (`--force`) |
| `SWITCHBOARD_ACTIVITY=claude` | also report live Claude Code sessions to the dashboard (off by default: titles summarise what was asked) |
| `~/.switchboard/config.json` | account credential + machine id (0600) |
| `~/.switchboard/daemons.json` | who is currently serving this machine (0600) |

`WEBTERM_*` spellings of the first three are accepted too.

## When something's wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `Not signed in on this machine.` | `nodes`/`exec`/`shell` need the account credential, not a token | `switchboard login` here |
| `does not accept peer connections` | the *target* was started with `SWITCHBOARD_PEER=0` | restart it without that; the relay enforces this, so there's no client-side way around it |
| `“x” is offline (last seen …)` | no daemon connected there | start one over there, or check the box is awake |
| `“x” matches 3 machines` | ambiguous prefix | use a longer prefix or the full id from `nodes` |
| `already has a daemon connected on the relay` (409) | a relay that refuses newcomers rather than handing the circuit over (older or self-hosted) | stop the other daemon, or pick a different `--token` |
| `relay rejected this machine (401)` | the stored credential is invalid or expired | `switchboard login` again |
| `relay rejected this machine (403)` | this machine id is already owned by another account, and ownership doesn't transfer | log in as that account, or drop `machineId` from `~/.switchboard/config.json` so the next login mints a new one (the old row stays in that account's dashboard) |
| `replaced by a newer daemon; exiting` | something else took the circuit — normal after a restart, suspicious otherwise | see who: `~/.switchboard/daemons.json` |
| `doesn't support reaching peer machines yet` | the relay is older than peer support | deploy the relay first, then the CLI |
| `npm install` fails building node-pty on Linux | no toolchain (there are no Linux prebuilds) | `apt install -y python3 make g++`, or the distro equivalent |
| unit vanishes after a while | it was installed from npx's cache, which npm evicts | `npm i -g @switch-board/cli`, then reinstall the service |

## Two habits worth keeping

**Say which machine you're on.** `exec` output looks exactly like local output.
When you report a result, name the host — "tests pass on build-box" — or the user
has no way to tell where it happened.

**Treat a remote command like a local one.** `exec` runs as that user with their
full shell. The usual care applies, and more so: you can't see what's on the
screen over there, or who's using it. Confirm anything destructive first, and
prefer `--timeout` for commands that might hang, since a wedged `exec` holds one
of the host's 8 slots.
