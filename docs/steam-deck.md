# Running on a Steam Deck (and other immutable distros)

SteamOS is Arch underneath, so the daemon itself needs nothing special — but the
rootfs is read-only and there is no compiler, which breaks the two habits the
normal Linux install relies on: `pacman install` and building node-pty from
source. Everything below keeps to `$HOME`, so a SteamOS update that reflashes
the system partition leaves the install alone.

The same shape applies to any immutable or toolchain-less distro — Fedora
Silverblue, ChromeOS's Linux container, a locked-down work laptop.

## Install without a toolchain

node-pty ships prebuilt binaries for macOS and Windows but **not Linux**, so a
normal `npm install` compiles it — and there is nothing on a Deck to compile it
with. Two ways out:

**Copy a build from another Linux box.** A `pty.node` built against an *older*
glibc runs fine against a newer one, so anything reasonably current works:
SteamOS 3.8 ships glibc 2.41, and a binary needing 2.34 loads without complaint.
Check before you copy:

```bash
# on the machine that has a toolchain
objdump -T node_modules/node-pty/build/Release/pty.node | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1
# on the Deck
ldd --version | head -1
```

Then install Node and the CLI under `$HOME` and drop the tree in:

```bash
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz | tar xJ
mv node-v22.23.1-linux-x64 node
# untar the @switch-board tree from the build machine into:
#   ~/.local/opt/node/lib/node_modules/
ln -sf ../lib/node_modules/@switch-board/cli/index.js ~/.local/opt/node/bin/switchboard
```

**Or build in a container.** `distrobox`/`toolbox` is available on SteamOS and
gives you a throwaway Arch with `base-devel`; install there and copy the result
out. Slower to set up, but it's self-contained.

Verify the native module actually loads before going further — a `pty.node` that
imports but can't spawn will fail later, in the middle of the daemon:

```bash
~/.local/opt/node/bin/node -e '
const pty = require(process.env.HOME + "/.local/opt/node/lib/node_modules/@switch-board/cli/node_modules/node-pty");
const p = pty.spawn("/bin/bash", [], {cols: 80, rows: 24, env: process.env});
p.onData(() => { console.log("pty ok"); process.exit(0); });
p.write("echo hi\r");
setTimeout(() => { console.error("pty timed out"); process.exit(1); }, 5000);'
```

## Put PATH in `~/.bash_profile`, not `~/.bashrc`

This one bites specifically here. `exec` runs its command in a **login** shell
(`$SHELL -lc`) so that version-managed tools exist over there — but Arch's
default `~/.bashrc` opens with

```bash
# If not running interactively, don't do anything
[[ $- != *i* ]] && return
```

and `bash -lc` is not interactive. A `PATH` line appended to `~/.bashrc` is
never reached, so `switchboard exec deck which node` comes back empty while an
interactive SSH session finds it perfectly well. Put it where a non-interactive
login shell will actually read it:

```bash
echo 'export PATH="$HOME/.local/opt/node/bin:$PATH"' >> ~/.bash_profile
```

If you later `chsh` to zsh, note the unit pins `SWITCHBOARD_SHELL` to whatever
`$SHELL` was at install time — sessions keep spawning the old shell until you
edit `~/.config/systemd/user/switchboard.service` and restart it.

## Signing in over a flaky link

`switchboard login` prints a URL and polls until you authorize it. The URL is
just a `state` code, so **you can open it on any device** — phone, desktop,
whatever is nearest — which saves switching the Deck to desktop mode.

The agent token it mints is bound to your *account*, not to the machine; the
machine id is generated client-side. So on a box whose network is unreliable you
can run the whole handshake somewhere stable, then copy the credential over and
let the daemon mint its own machine id:

```bash
# ~/.switchboard/config.json, mode 0600
{ "server": "https://shell.lfkdsk.org", "agentToken": "…", "login": "you",
  "machineId": "<a fresh uuid>" }
```

Give each machine its own token rather than sharing one, so revoking a Deck
you've lent out doesn't sign out your laptop too.

## Suspend

A sleeping Deck is an offline node: the CPU is stopped, so the daemon is stopped
too. What matters is what happens either side of that, and whether you can end it
remotely — you can, see [Wake-on-WLAN](#wake-on-wlan) below.

**Going to sleep** costs you nothing you can't get back. Shell sessions live in
RAM and come back exactly as they were, with whatever was running still running.
`exec` is the exception — it's killed deliberately when the link drops, since its
output has nowhere to go — so put anything long in a `shell` session.

**Waking up** is handled: the link is half-open at that point (the relay wrote
this machine off minutes ago, but the socket still says `OPEN`), and the daemon's
pong watchdog notices within `PONG_TIMEOUT_MS` and reconnects. On a real Deck,
resume to reconnected takes a few seconds, with one DNS failure in between while
NetworkManager brings `wlan0` back:

```
01:09:16  kernel: PM: suspend entry (deep)
01:16:04  kernel: PM: suspend exit
01:16:04  [relay] no pong for 10000ms; link is half-open, reconnecting
01:16:05  [relay] error: getaddrinfo EAI_AGAIN shell.lfkdsk.org
01:16:07  [relay] connected
```

Wi-Fi power saving (`iw dev wlan0 get power_save` → on, by default) is *not* a
problem for the daemon: it sends stats every two seconds, which keeps the radio
up and the connection alive. Leave it on and keep the battery life.

### Staying awake while docked

**Check before you build anything.** On a stock Deck, auto-suspend is configured
for battery only — `~/.config/powerdevilrc` carries an
`AutoSuspendIdleTimeoutSec` under `[Battery]` and *none* under `[AC]`, so a
plugged-in Deck in desktop mode already stays awake indefinitely and merely
blanks the screen (`TurnOffDisplayIdleTimeoutSec`, 30 min by default). If that's
what you wanted, you're done: dock it and it stays reachable.

```bash
cat ~/.config/powerdevilrc     # look for AutoSuspendIdleTimeoutSec under [AC]
```

Game mode is Steam's own power management, not Powerdevil, and has a separate
timeout — check there too if that's where you leave it.

A logind inhibitor is the wrong reflex here, and worth understanding before you
reach for one elsewhere. `--what=sleep` in `--mode=block` refuses **every**
suspend request logind sees, including the one you make by pressing the power
button — so on a Deck that already never auto-suspends on AC, it prevents
nothing and costs you the button. `--what=idle` is broader still: it tells
logind the session is never idle, which also suppresses the screen blanking you
probably wanted to keep.

To turn the screen off by hand without suspending, blank the display directly:

```bash
kscreen-doctor --dpms off      # Wayland/KDE; any input turns it back on
```

## Wake-on-WLAN

A suspended Deck *can* be woken over the network, which turns "asleep" from a
dead end into a five-second detour. The hardware supports it — the OLED's
QCNFA765 on `ath11k_pci` advertises magic-packet wake — but three things have to
be right, and two of them are counter-intuitive.

```bash
iw phy | grep -A6 -i wowlan     # confirm "wake up on magic packet" is listed
```

**Arm it while the machine is awake, not on the way down.** This is the one that
wastes an evening. NetworkManager checks for an armed WoWLAN when logind
announces `PrepareForSleep`, and *keeps the interface up* if it finds one;
otherwise it disassociates. So a unit ordered `Before=sleep.target`, or a script
in `/etc/systemd/system-sleep/`, is already too late — it runs after NM has torn
the link down, `iw` reports success against the phy, and nothing is left to
receive a packet on. In testing that unit ran 0.35s before `PM: suspend entry`
and the Deck still could not be woken.

Arm it at boot instead, and again whenever the link comes back:

```ini
# /etc/systemd/system/wowlan-boot.service
[Unit]
Description=Keep WoWLAN magic-packet armed so this machine can be woken remotely
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/iw phy0 wowlan enable magic-packet
ExecStop=/usr/bin/iw phy0 wowlan disable

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/NetworkManager/dispatcher.d/90-wowlan  (mode 755) — reassociating clears it
#!/bin/bash
[ "$1" = "wlan0" ] || exit 0
case "$2" in
  up|dhcp4-change|dhcp6-change) /usr/bin/iw phy0 wowlan enable magic-packet ;;
esac
exit 0
```

**Don't bother with NetworkManager's own setting.** `802-11-wireless.wake-on-wlan
magic` looks like the supported way to do this and stores fine (`0x8`), but
SteamOS drives Wi-Fi through **iwd**, and with that backend the setting never
reaches the driver. Verified the hard way: disarm by hand, suspend, and the Deck
ignores magic packets despite the connection profile asking for them.

**Send the magic packet unicast, not broadcast.** An access point may simply drop
broadcast frames addressed to a dozing station, and the measured difference is
stark — unicast woke the Deck 4 times out of 4, always within five seconds, while
broadcast managed one wake in two attempts. Aim it at the Deck's own address so
the AP buffers it and delivers it on the next DTIM beacon:

```python
import socket
pkt = b"\xff" * 6 + bytes.fromhex("2cc682ff59b5") * 16   # the Deck's MAC
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(pkt, ("192.168.12.193", 9))                     # its IP, not .255
```

The packet has to originate on the Deck's own LAN, so if the machine you're
sitting at is elsewhere, send it *through* a machine that isn't:
`switchboard exec macbook wake-deck`.

**Beware of coincidences when testing this.** The AC adapter is a wake source
(`/sys/kernel/debug/wakeup_sources`), and a marginal cable or a dock reseating
itself will wake a Deck on its own — during this work one such wake landed a few
seconds after a magic packet and looked exactly like success. Confirm the Deck
has held sleep for ~40s before sending anything, and repeat the test before
believing it.

## Game mode

None of this needs desktop mode once it's installed; the unit is a user service
and `enable-linger` (which `service install` turns on) keeps it running whether
or not anyone is logged into a desktop session. Switching to game mode doesn't
drop the node.
