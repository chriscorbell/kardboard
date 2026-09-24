# syntax=docker/dockerfile:1.7
# The default Session image. One image for every board; a board may override it.
# Toolchains: Node (pnpm, bun), Python (uv), Go, git, gh, Claude Code, Codex CLI.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq openssh-client build-essential pkg-config \
      python3 python3-venv unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# gh
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# Node 24 + pnpm + bun
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.25.0 --activate
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Go
ARG GO_VERSION=1.25.1
RUN curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# uv
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Provider CLIs. Codex is pinned: its CLI has removed flags and config keys between releases, and
# the entrypoint's Codex invocation is verified against this version. Bump it deliberately.
ARG CODEX_VERSION=0.154.0
RUN npm install -g @anthropic-ai/claude-code "@openai/codex@${CODEX_VERSION}"

RUN useradd -m -u 1001 -s /bin/bash agent && mkdir -p /work /home/agent/.claude && chown -R agent:agent /work /home/agent \
    && printf '{ "includeCoAuthoredBy": false }\n' > /home/agent/.claude/settings.json && chown agent:agent /home/agent/.claude/settings.json

# Per-Board dependency caches. The runner mounts the Board's own named volume at /cache, and Docker
# seeds a new, empty volume from this directory, owner included, so it must exist and belong to the
# agent user. Each variable is the tool's documented one; pnpm 11 reads only pnpm_config_*, not
# npm_config_*. The volume is a different filesystem from /work, so uv, pnpm, and Bun copy from it
# rather than hard-link; UV_LINK_MODE says so up front instead of warning on every install.
RUN mkdir -p /cache && chown agent:agent /cache
ENV npm_config_cache=/cache/npm \
    pnpm_config_store_dir=/cache/pnpm/store \
    pnpm_config_cache_dir=/cache/pnpm/metadata \
    BUN_INSTALL_CACHE_DIR=/cache/bun \
    GOMODCACHE=/cache/go/mod \
    GOCACHE=/cache/go/build \
    UV_CACHE_DIR=/cache/uv \
    UV_LINK_MODE=copy \
    PIP_CACHE_DIR=/cache/pip
COPY --chmod=755 images/agent/entrypoint.sh /usr/local/bin/kardboard-session
USER agent
WORKDIR /work
ENV HOME=/home/agent
ENTRYPOINT ["kardboard-session"]
