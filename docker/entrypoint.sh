#!/usr/bin/env bash
#
# Agent Box entrypoint: settle permissions, decide how this box joins the relay,
# then hand PID 1 to the Switchboard daemon.
set -euo pipefail

DEV_HOME=/home/dev
SB_DIR="$DEV_HOME/.switchboard"
CONFIG="$SB_DIR/config.json"
TOKEN_FILE="$SB_DIR/docker-token"
URL_FILE="$SB_DIR/share-url"

# Compose has no way to pass "this variable is absent" — an unset shell var
# becomes an empty string in the container. Empty is not a value any of these
# accept, so scrub them or the daemon will reject a 0-length token and the CLIs
# will try to authenticate with an empty key.
for v in SWITCHBOARD_TOKEN SWITCHBOARD_ACTIVITY SWITCHBOARD_MODE \
         ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN \
         OPENAI_API_KEY OPENAI_BASE_URL; do
  if [ -z "${!v:-}" ]; then unset "$v" || true; fi
done

# ---- root half: fix up the mounts, then drop privileges ---------------------
if [ "$(id -u)" = "0" ]; then
  # On a Linux host a bind-mounted workspace arrives owned by the host's uid, and
  # a container user that doesn't match it can't write. Realign instead of
  # chmod 777. (Docker Desktop on macOS/Windows already maps this for you.)
  if [ -n "${HOST_UID:-}" ] && [ "$HOST_UID" != "$(id -u dev)" ]; then
    groupmod -o -g "${HOST_GID:-$HOST_UID}" dev
    usermod  -o -u "$HOST_UID" -g "${HOST_GID:-$HOST_UID}" dev
    chown -R dev:dev "$DEV_HOME"
  fi

  mkdir -p "$SB_DIR" "$DEV_HOME/.claude" "$DEV_HOME/.codex" /workspace
  # Shallow by default: a workspace volume with a few node_modules trees in it
  # can take minutes to walk, on every single start. Set SB_CHOWN_ALL=1 once if
  # you inherit a volume with the wrong ownership inside.
  chown dev:dev "$DEV_HOME" /workspace 2>/dev/null || true
  # These three, recursively: `docker compose exec` skips this entrypoint and so
  # lands you as root, and one `codex` run that way leaves root-owned files under
  # ~/.codex that the real (dev) shells then fail on with a baffling EPERM. Cheap
  # to re-assert — they're config directories, not the workspace.
  chown -R dev:dev "$SB_DIR" "$DEV_HOME/.claude" "$DEV_HOME/.codex" 2>/dev/null || true
  if [ -n "${SB_CHOWN_ALL:-}" ]; then
    echo "[agentbox] SB_CHOWN_ALL set — reclaiming ownership of /home/dev and /workspace…"
    chown -R dev:dev "$DEV_HOME" /workspace
  fi

  exec gosu dev "$0" "$@"
fi

# ---- everything below runs as dev -------------------------------------------

# Credentials handed in by `run.sh import-creds`, which bind-mounts a temp dir at
# /seed. This runs before the command dispatch below because that's exactly how
# import-creds drives it: a throwaway `compose run … true` that only exists to
# get the seeding done. Never overwrite a login made inside the box — the copy in
# the volume is the one the user has been refreshing.
seed() { # seed <src-in-/seed> <dest>
  [ -f "/seed/$1" ] || return 0
  if [ -s "$2" ]; then echo "[agentbox] keeping existing $2 (seed skipped)"; return 0; fi
  mkdir -p "$(dirname "$2")"
  install -m 0600 "/seed/$1" "$2"
  echo "[agentbox] seeded $2 from the host"
}
if [ -d /seed ]; then
  seed claude-credentials.json "$DEV_HOME/.claude/.credentials.json"
  seed codex-auth.json         "$DEV_HOME/.codex/auth.json"
fi

# `docker run … bash` / `docker compose run … <cmd>`: honour it and skip the daemon.
if [ "$#" -gt 0 ]; then exec "$@"; fi

have_account() { [ -s "$CONFIG" ] && grep -q '"agentToken"' "$CONFIG"; }
new_token()    { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }

MODE="${SWITCHBOARD_MODE:-auto}"
SERVER="${SWITCHBOARD_SERVER:-https://shell.lfkdsk.org}"

case "$MODE" in
  auto)
    if [ -n "${SWITCHBOARD_TOKEN:-}" ] || [ -s "$TOKEN_FILE" ]; then MODE=token
    elif have_account; then MODE=account
    else MODE=token
    fi
    ;;
  token|login|account) ;;
  *) echo "[agentbox] unknown SWITCHBOARD_MODE=$MODE (want: auto|token|login|account)" >&2; exit 1 ;;
esac

mkdir -p "$SB_DIR"

case "$MODE" in
  token)
    # A random token per restart would mean a new URL per restart, and whoever you
    # sent the old one to is silently locked out. Mint once, keep it in the home
    # volume, reuse it forever.
    TOKEN="${SWITCHBOARD_TOKEN:-}"
    if [ -z "$TOKEN" ] && [ -s "$TOKEN_FILE" ]; then TOKEN="$(cat "$TOKEN_FILE")"; fi
    if [ -z "$TOKEN" ]; then
      TOKEN="$(new_token)"
      ( umask 077; printf '%s' "$TOKEN" > "$TOKEN_FILE" )
      echo "[agentbox] minted a new share token (stored in the home volume; it survives restarts)"
    fi
    URL="$SERVER/?token=$TOKEN"
    ( umask 077; printf '%s\n' "$URL" > "$URL_FILE" )

    cat <<EOF

  ┌──────────────────────────────────────────────────────────────────┐
    Agent Box — share this URL and your friend gets a shell in here:

      $URL

    Inside: claude · codex · git · node.  Work in /workspace (persistent).
    Anyone holding that URL has a shell in this container. Treat it as a
    password; \`run.sh rotate\` mints a fresh one and invalidates this.
  └──────────────────────────────────────────────────────────────────┘

EOF
    exec switchboard --token "$TOKEN"
    ;;

  login)
    if have_account; then exec switchboard; fi
    echo "[agentbox] not signed in yet — starting the GitHub sign-in flow."
    echo "[agentbox] open the URL below (\`run.sh logs -f\` if you can't see it)."
    exec switchboard login     # prints the URL, waits, then serves in the same process
    ;;

  account)
    if ! have_account; then
      cat >&2 <<'EOF'
[agentbox] SWITCHBOARD_MODE=account, but this box has no stored credential.
           Sign it in once — the credential lands in the home volume and sticks:

             ./run.sh login

EOF
      exit 1
    fi
    echo "[agentbox] signed in — this box appears in your dashboard: $SERVER"
    exec switchboard
    ;;
esac
