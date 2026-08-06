# /etc/bash.bashrc — system-wide bashrc for the Agent Box.
#
# This lives in /etc rather than ~/.bashrc on purpose: the home directory is a
# persistent volume, so anything seeded there on first run never updates again.
# /etc always comes from the image you're actually running.

[[ $- == *i* ]] || return          # interactive shells only

# ---- shell behaviour --------------------------------------------------------
shopt -s checkwinsize histappend
HISTSIZE=10000
HISTFILESIZE=50000
HISTCONTROL=ignoreboth

# Colours only where the terminal will actually render them. Switchboard's
# browser terminal is xterm-color, so it will.
case "$TERM" in xterm*|rxvt*|screen*|tmux*|*color*)
  PS1='\[\e[1;32m\]agentbox\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
  alias ls='ls --color=auto'
  alias grep='grep --color=auto'
  ;;
*) PS1='agentbox:\w\$ ' ;;
esac

alias ll='ls -alF'
alias la='ls -A'
alias ..='cd ..'

# node-pty starts every shell in $HOME. /workspace is the volume that's actually
# meant to hold work, so land there — but only when nothing else moved us first.
[[ "$PWD" == "$HOME" ]] && cd /workspace 2>/dev/null

# ---- greeting ---------------------------------------------------------------
# Printed per shell, not once per container: each browser tab is a fresh shell
# and possibly a different person's first look at this box.
if [[ -z "$AGENTBOX_QUIET" ]]; then
  __ab_state() { # __ab_state <name> <credential path…>
    local name=$1; shift
    for f in "$@"; do [[ -s "$f" ]] && { printf '%s \e[32m✓ signed in\e[0m' "$name"; return; }; done
    printf '%s \e[33m— not signed in\e[0m' "$name"
  }

  printf '\n  \e[1mAgent Box\e[0m — a sandbox with Claude Code and Codex in it.\n\n'
  printf '    %s\n' "$(__ab_state 'claude ' "$HOME/.claude/.credentials.json")"
  printf '    %s\n' "$(__ab_state 'codex  ' "$HOME/.codex/auth.json")"
  printf '\n'
  printf '    \e[2mSign in:\e[0m  \e[1mclaude\e[0m then \e[1m/login\e[0m\n'
  printf '              \e[1mcodex login --device-auth\e[0m \e[2m(plain `codex login` opens a callback on\n'
  printf '              localhost:1455, which is this container, not your machine)\e[0m\n'
  printf '    \e[2mWork in\e[0m   /workspace \e[2m(persists across restarts; $HOME does too)\e[0m\n'
  printf '    \e[2mNothing else on the host machine is reachable from in here.\e[0m\n\n'

  unset -f __ab_state
fi
