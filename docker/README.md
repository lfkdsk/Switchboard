# Agent Box

A container with **Claude Code** and **Codex** in it, reachable from any browser
through a Switchboard relay. Start it, hand someone the URL, and they get a real
terminal inside the box — with the agents already installed — without an account
on your machine, an SSH key, a VPN, or an open port.

```bash
cd docker && ./run.sh
```

That's the whole thing. It builds the image on first run, starts the box, and
prints:

```
  Share this URL:

    https://shell.lfkdsk.org/?token=rf0ZqJgJt7P2MV3nR59J1A5pd2MVqnBZ4WqT7t2lO0I
```

Send that to a friend. They open it and land in `/workspace` with `claude`,
`codex`, `git`, and `node` on their PATH.

---

## Why a container

The box dials *out* to the relay, exactly like the bare CLI does — so this works
from a laptop behind NAT with no inbound ports. The difference is what's on the
other end of the URL: a container, not your machine. Whoever you share with gets
root-via-sudo in a sandbox with its own filesystem, and nothing of yours is
mounted into it.

That's the security model, and it's the whole reason to prefer this over running
`switchboard` on your host: **the token is still the only credential**, but the
blast radius is a container you can throw away with `./run.sh reset`.

---

## Signing the agents in

Nobody's credentials are baked into the image. The two logins live in the `home`
volume, so they're done once and survive restarts and rebuilds.

**Claude Code** — works from anywhere, including for a remote friend:

```bash
claude          # then: /login   → open the URL, paste the code back
```

**Codex** — use the device-code flow, not the default one:

```bash
codex login --device-auth      # open the printed link, type the one-time code
```

Plain `codex login` is an OAuth *loopback* flow: it starts a server on port 1455
and hands OpenAI a fixed `redirect_uri` of `http://localhost:1455/auth/callback`.
That's registered with OpenAI's OAuth app, so it can't be pointed anywhere else —
it assumes the browser and the CLI are on the same machine. Here they aren't:
`localhost` in your friend's browser is *their* laptop, not the box. The callback
never arrives and the login hangs.

`--device-auth` has no callback at all, so it works from anywhere. There's also
`printenv OPENAI_API_KEY | codex login --with-api-key` if you'd rather use a key.

### Lending your own logins

`./run.sh import-creds` copies this host's Claude and Codex credentials into the
box (on macOS it reads Claude's token out of the Keychain). It never overwrites a
login already made inside the box.

> Think before you do this. Everyone with the share URL is then spending your
> quota under your account, and account sharing is against both vendors' terms.
> Having each person run `/login` themselves is the better default.

---

## Commands

| | |
| --- | --- |
| `./run.sh` | build if needed, start, print the share URL |
| `./run.sh url` | print the share URL again |
| `./run.sh logs -f` | follow the daemon's log |
| `./run.sh shell` | a shell in the box from your own terminal |
| `./run.sh rotate` | mint a new token — the old URL stops working |
| `./run.sh login` | bind the box to your GitHub account instead (see below) |
| `./run.sh share` | switch back to token mode |
| `./run.sh import-creds` | copy this host's claude/codex logins in |
| `./run.sh rebuild` | pull newer claude/codex/switchboard, recreate |
| `./run.sh down` | stop it; volumes survive |
| `./run.sh reset` | stop it and delete the volumes too |

## Two ways to connect

Same split as the CLI itself:

- **Token mode** (default) — the URL is the credential. Anyone holding it gets a
  shell. This is the sharing mode.
- **Account mode** (`./run.sh login`) — the box binds to your GitHub account and
  shows up in your dashboard with live CPU/memory/latency. Only you can open it,
  so it's for *your* box, not a shared one.

The mode is remembered in `.env`. Switching is a recreate, not a rebuild.

## What persists

Two named volumes, both surviving `down` and `rebuild`:

- `agentbox_workspace` → `/workspace` — the code people work on
- `agentbox_home` → `/home/dev` — logins, shell history, `~/.claude`, `~/.codex`,
  and anything `npm i -g` puts in `~/.npm-global`

Only `./run.sh reset` deletes them.

Note that `~/.bashrc` is *not* where the box's shell setup lives — it's
`/etc/bash.bashrc`, baked into the image. A home volume is written once on
creation and then never refreshed, so anything seeded there would go stale the
first time you rebuilt.

## Configuration

`run.sh` copies `.env.example` to `.env` on first run; every key is optional.
The ones worth knowing:

| | |
| --- | --- |
| `SWITCHBOARD_SERVER` | which relay to dial — point it at your own if you self-host |
| `SWITCHBOARD_TOKEN` | pin your own token instead of the generated one (min 24 chars) |
| `SWITCHBOARD_ACTIVITY=claude` | also report live Claude Code sessions to the dashboard |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | skip the interactive logins |
| `AGENTBOX_NAME` | run more than one box on the same host |
| `CLAUDE_CODE_VERSION`, `CODEX_VERSION` | pin versions for a reproducible build |

Running several boxes: `AGENTBOX_NAME=box2 ./run.sh` — the volumes are namespaced
by compose project, so give each one its own directory or set
`COMPOSE_PROJECT_NAME` too.

## Requirements

Docker, and Compose v2. On macOS, without a Docker Desktop install:

```bash
brew install colima docker docker-compose
colima start --cpu 6 --memory 12 --disk 80
```

then add Homebrew's plugin directory to `~/.docker/config.json` so `docker
compose` resolves:

```json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

`run.sh` runs `colima start` for you if the daemon isn't up.

## Notes on the image

- **Base:** `node:22-bookworm-slim`, plus `git`, `ripgrep`, `fd`, `jq`, `tmux`,
  and an `openssh-client`. `dev` (uid 1000) has passwordless `sudo`, so anything
  missing is one `apt install` away.
- **Two stages.** node-pty ships no Linux prebuild and has to compile, so it does
  that in the full `node:22-bookworm` image and only the built artifact crosses
  into the runtime — no compiler in the shipped image.
- **Auto-update is off** (`DISABLE_AUTOUPDATER=1`): the agents are installed into
  root-owned `/opt/agents` and self-updating would just fail noisily. Upgrade
  with `./run.sh rebuild`.
- **`docker compose exec` lands you as root**, because it bypasses the
  entrypoint's privilege drop. Use `./run.sh shell`, which passes `-u dev` — root
  files in `/workspace` are unwritable from the shells people actually use.
