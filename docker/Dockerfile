# syntax=docker/dockerfile:1
#
# Agent Box — Claude Code + Codex in a container, reachable from any browser
# through a Switchboard relay. The box dials *out*, so there is nothing to
# port-forward and nothing to expose: hand a friend the URL and they get a real
# shell in this container, not on your machine.

ARG NODE_VERSION=22

# ---- build stage ------------------------------------------------------------
# node-pty ships prebuilt binaries for macOS and Windows but not Linux, so it
# compiles from source. Do that in the fat image that already has a toolchain and
# carry only the result forward — the runtime stays slim and compiler-free.
FROM node:${NODE_VERSION}-bookworm AS build

ARG SWITCHBOARD_CLI_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --prefix /opt/agents \
      "@switch-board/cli@${SWITCHBOARD_CLI_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# Smoke-test the one thing that could silently fail: requiring the daemon pulls
# in the node-pty binding we just compiled. Better to fail the build than to ship
# an image that dies on first run.
RUN /opt/agents/bin/switchboard --version \
 && /opt/agents/bin/claude --version \
 && /opt/agents/bin/codex --version

# ---- runtime stage ----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget \
      git git-lfs openssh-client \
      less nano procps psmisc lsof net-tools iputils-ping \
      ripgrep fd-find jq unzip zip xz-utils \
      tmux tini gosu sudo \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(command -v fdfind)" /usr/local/bin/fd

# The node image already ships a uid-1000 user; rename it rather than stacking a
# second one, so /home/dev is uid 1000 and bind mounts line up on Linux hosts.
RUN usermod -l dev -d /home/dev -m node \
 && groupmod -n dev node \
 && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev \
 && chmod 0440 /etc/sudoers.d/dev

COPY --from=build /opt/agents /opt/agents

ENV HOME=/home/dev \
    LANG=C.UTF-8 \
    SHELL=/bin/bash \
    EDITOR=nano \
    PATH=/home/dev/.local/bin:/home/dev/.npm-global/bin:/opt/agents/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/dev/.npm-global \
    SWITCHBOARD_SERVER=https://shell.lfkdsk.org \
    SWITCHBOARD_SHELL=/bin/bash \
    SWITCHBOARD_MODE=auto \
    DISABLE_AUTOUPDATER=1

# The system bashrc, not ~/.bashrc: the home directory is a persistent volume, so
# anything seeded there on first run goes stale the moment the image is rebuilt.
# /etc always comes from the current image.
COPY bash.bashrc /etc/bash.bashrc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /workspace /home/dev/.switchboard /home/dev/.claude /home/dev/.codex \
             /home/dev/.npm-global /home/dev/.local/bin \
 && chown -R dev:dev /workspace /home/dev

WORKDIR /workspace

# tini reaps the PTY children the shells leave behind; the daemon itself handles
# SIGTERM and exits 0 when the relay hands its circuit to a newer instance.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
