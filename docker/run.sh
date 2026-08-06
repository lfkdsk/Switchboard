#!/usr/bin/env bash
#
# Agent Box — one command to build, start, and share a container with Claude Code
# and Codex in it.  ./run.sh   is the whole thing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Homebrew's bin is on an interactive shell's PATH via ~/.zprofile, but not a
# non-login one — and this script gets run from both.
case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac

SERVICE=agentbox
ENV_FILE=.env

bold() { printf '\e[1m%s\e[0m\n' "$*"; }
warn() { printf '\e[33m%s\e[0m\n' "$*" >&2; }
die()  { printf '\e[31m%s\e[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------
command -v docker >/dev/null || die "docker isn't installed. On macOS: brew install colima docker docker-compose && colima start"

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  die "Docker Compose isn't available. brew install docker-compose, then add /opt/homebrew/lib/docker/cli-plugins to cliPluginsExtraDirs in ~/.docker/config.json"
fi

if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    bold "Docker isn't running — starting colima…"
    colima start
  else
    die "Can't reach the Docker daemon. Start Docker Desktop (or \`colima start\`) and retry."
  fi
fi

[ -f "$ENV_FILE" ] || { cp .env.example "$ENV_FILE"; bold "Created $ENV_FILE — edit it to change the relay, token, or API keys."; }

# Set a key in .env, replacing any existing line for it.
set_env() {
  local k=$1 v=$2 tmp
  tmp=$(mktemp)
  grep -v "^${k}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# The daemon writes its share URL here the moment it settles on a token.
read_url() {
  dc exec -T "$SERVICE" cat /home/dev/.switchboard/share-url 2>/dev/null | tr -d '\r'
}

wait_for_url() {
  local i
  for i in $(seq 1 40); do
    local u; u=$(read_url || true)
    if [ -n "$u" ]; then printf '\n'; bold "  Share this URL:"; printf '\n    \e[4m%s\e[0m\n\n' "$u"; return 0; fi
    sleep 0.5
  done
  warn "No share URL yet — this box is probably in account mode. Check: ./run.sh logs"
}

# ---- commands ---------------------------------------------------------------
cmd_up() {
  dc up -d --build "$@"
  wait_for_url
  printf '  \e[2mlogs: ./run.sh logs -f    ·    a shell in the box: ./run.sh shell\e[0m\n\n'
}

cmd_down()    { dc down "$@"; }
cmd_restart() { dc restart "$@"; wait_for_url; }
cmd_logs()    { dc logs "${@:--n 200}"; }
cmd_ps()      { dc ps; }
cmd_url()     { read_url || die "No share URL — is the box up? (./run.sh ps)"; }
# -u dev, because `exec` enters the container directly and so skips the
# entrypoint's privilege drop. Without it this shell would be root while the
# browser's is dev, and anything it touched in /workspace would come back
# root-owned and unwritable from the shells people actually use.
cmd_shell()   { dc exec -u dev "$SERVICE" bash -l; }

cmd_rebuild() {
  # --pull so `latest` in the Dockerfile actually means latest, and --no-cache so
  # the npm layer is re-resolved rather than replayed.
  dc build --pull --no-cache
  dc up -d --force-recreate
  wait_for_url
}

cmd_login() {
  bold "Switching the box to account mode (GitHub sign-in)…"
  set_env SWITCHBOARD_MODE login
  dc up -d --force-recreate
  printf '\n  Open the URL that appears below and authorize. Ctrl-C once it says signed in —\n'
  printf '  the box keeps running in the background.\n\n'
  dc logs -f
}

cmd_share() {
  bold "Switching the box back to token mode (shareable URL)…"
  set_env SWITCHBOARD_MODE token
  dc up -d --force-recreate
  wait_for_url
}

cmd_rotate() {
  bold "Minting a new share token — the old URL stops working immediately."
  dc exec -T "$SERVICE" rm -f /home/dev/.switchboard/docker-token /home/dev/.switchboard/share-url
  set_env SWITCHBOARD_TOKEN ""
  dc up -d --force-recreate
  wait_for_url
}

cmd_import_creds() {
  warn "This copies YOUR Claude/Codex logins into the box. Anyone you share the URL"
  warn "with will then be spending your quota under your account. Ctrl-C to back out."
  printf 'Continue? [y/N] '; read -r a; [[ "$a" =~ ^[Yy]$ ]] || exit 1

  local seed; seed=$(mktemp -d); chmod 700 "$seed"
  # shellcheck disable=SC2064
  trap "rm -rf '$seed'" EXIT

  # macOS keeps the Claude Code token in the Keychain; Linux keeps it in a file.
  if [[ "$OSTYPE" == darwin* ]] && security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then
    security find-generic-password -s "Claude Code-credentials" -w > "$seed/claude-credentials.json"
    bold "  ✓ claude — from the macOS Keychain"
  elif [ -s "$HOME/.claude/.credentials.json" ]; then
    cp "$HOME/.claude/.credentials.json" "$seed/claude-credentials.json"
    bold "  ✓ claude — from ~/.claude/.credentials.json"
  else
    warn "  – claude: no credentials found on this host, skipping"
  fi

  if [ -s "$HOME/.codex/auth.json" ]; then
    cp "$HOME/.codex/auth.json" "$seed/codex-auth.json"
    bold "  ✓ codex — from ~/.codex/auth.json"
  else
    warn "  – codex: no ~/.codex/auth.json on this host, skipping"
  fi

  # A throwaway container that shares the box's home volume: the entrypoint seeds
  # from /seed before it dispatches the command, so `true` is enough.
  dc run --rm -v "$seed:/seed:ro" "$SERVICE" true
  bold "Done. Existing logins inside the box were left alone."
}

cmd_reset() {
  warn "This deletes the box AND both volumes — /workspace and every login in it."
  printf 'Type the word DESTROY to confirm: '; read -r a
  [ "$a" = "DESTROY" ] || die "Aborted."
  dc down -v
  bold "Gone."
}

usage() {
  cat <<'EOF'
Agent Box — Claude Code + Codex in a container, reachable from any browser.

  ./run.sh                 build if needed, start, print the share URL
  ./run.sh url             print the share URL again
  ./run.sh logs [-f]       the daemon's log
  ./run.sh shell           a shell in the box, from this terminal
  ./run.sh ps              is it up?

  ./run.sh login           bind the box to your GitHub account (dashboard mode)
  ./run.sh share           back to token mode (shareable URL)
  ./run.sh rotate          mint a new token; the old URL dies

  ./run.sh import-creds    copy this host's claude/codex logins into the box
  ./run.sh rebuild         pull newer claude/codex/switchboard and recreate
  ./run.sh down            stop it (volumes survive)
  ./run.sh reset           stop it and delete the volumes too
EOF
}

case "${1:-up}" in
  up|start)      shift || true; cmd_up "$@" ;;
  down|stop)     shift || true; cmd_down "$@" ;;
  restart)       shift || true; cmd_restart "$@" ;;
  logs)          shift || true; cmd_logs "$@" ;;
  ps|status)     cmd_ps ;;
  url)           cmd_url ;;
  shell|exec)    cmd_shell ;;
  rebuild)       cmd_rebuild ;;
  login)         cmd_login ;;
  share)         cmd_share ;;
  rotate)        cmd_rotate ;;
  import-creds)  cmd_import_creds ;;
  reset)         cmd_reset ;;
  -h|--help|help) usage ;;
  *)             usage; exit 1 ;;
esac
