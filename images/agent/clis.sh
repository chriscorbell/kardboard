#!/usr/bin/env bash
# Keeps the newest Claude Code and Codex in the volume the runner mounts, read-only, into every
# Session at /opt/kardboard-clis, so a Session runs the latest release without the image being
# rebuilt for it. The runner watches npm and runs `kardboard-clis ensure <tool> <version>` as root
# in a short-lived container of this image when a version appears, or when the image changes.
#
# Each version lives in a directory of its own, <tool>/<version>, and <tool>/current points at the
# one Sessions use. A version becomes current only after `check` has run it the way this image's
# entrypoint will, so a release that drops a flag or a config key the entrypoint depends on never
# reaches a Session: the previous version stays current. When the current version fails the checks
# of a newer image, the pointer is removed and Sessions fall back to the CLI built into the image.
set -euo pipefail

ROOT="${KARDBOARD_CLIS_DIR:-/opt/kardboard-clis}"
# The marker a version gets once it has passed its checks. The entrypoint uses no directory without it.
CHECKED=".kardboard-checked"
# Versions kept whatever their age, the current one included.
KEEP=2
# How long a replaced version stays for Sessions that started on it: well past the 55-minute cap on
# a Session's wall clock.
GRACE_SECONDS=$((3 * 3600))

# shellcheck source=codex-config.sh
. "${KARDBOARD_CODEX_CONFIG:-/usr/local/lib/kardboard/codex-config.sh}"

log() { printf '[kardboard-clis] %s\n' "$*" >&2; }

package_of() {
  case "$1" in
    claude-code) echo "@anthropic-ai/claude-code" ;;
    codex) echo "@openai/codex" ;;
    *) return 1 ;;
  esac
}

bin_of() {
  case "$1" in
    claude-code) echo claude ;;
    codex) echo codex ;;
  esac
}

# The flags the entrypoint passes each CLI. Keep these in step with it.
CLAUDE_FLAGS=(--print --model --mcp-config --permission-mode --allowedTools --output-format --verbose)
CODEX_EXEC_FLAGS=(--dangerously-bypass-approvals-and-sandbox --strict-config --skip-git-repo-check --model --config)

# Whether a help text lists a flag as a whole word, so --model does not pass on --model-provider.
has_flag() { grep -qE -- "(^|[^[:alnum:]-])$2([^[:alnum:]-]|\$)" <<<"$1"; }

# Runs the CLI installed under a prefix the way the entrypoint will, without reaching any service.
check() {
  local tool=$1 prefix=$2 bin help flag home report seen
  bin="$prefix/bin/$(bin_of "$tool")"
  if ! "$bin" --version >/dev/null 2>&1; then
    log "$tool: $bin --version failed"
    return 1
  fi
  case "$tool" in
    claude-code)
      help="$("$bin" --help 2>&1 || true)"
      for flag in "${CLAUDE_FLAGS[@]}"; do
        has_flag "$help" "$flag" || { log "claude-code: --help no longer lists $flag"; return 1; }
      done
      ;;
    codex)
      help="$("$bin" exec --help 2>&1 || true)"
      for flag in "${CODEX_EXEC_FLAGS[@]}"; do
        has_flag "$help" "$flag" || { log "codex: exec --help no longer lists $flag"; return 1; }
      done
      # The Session's own config under --strict-config, with the -c override it may add. Nothing
      # listens on port 9, so doctor's reachability probes fail at once and change nothing here:
      # what matters is that the config loads, the MCP server is recognised, and inference would
      # not go over the WebSocket that bypasses the egress proxy.
      home="$(mktemp -d)"
      KARDBOARD_CODEX_EGRESS_URL=http://127.0.0.1:9/codex KARDBOARD_MCP_URL=http://127.0.0.1:9/mcp codex_config >"$home/config.toml"
      report="$(CODEX_HOME="$home" KARDBOARD_TOKEN=check "$bin" --strict-config doctor --json -c 'model_reasoning_effort="high"' 2>/dev/null || true)"
      rm -rf "$home"
      if ! jq -e '(.checks["config.load"].status == "ok")
          and (.checks["mcp.config"].details["configured servers"] == "1")
          and (.checks["network.websocket_reachability"].summary | test("not enabled"))' <<<"$report" >/dev/null 2>&1; then
        seen="$(jq -c '[.checks["config.load"].summary, .checks["mcp.config"].details, .checks["network.websocket_reachability"].summary]' <<<"$report" 2>/dev/null || true)"
        log "codex: doctor did not accept the Session's config: ${seen:-no report}"
        return 1
      fi
      ;;
  esac
}

current_of() { readlink "$ROOT/$1/current" 2>/dev/null || true; }

# Points <tool>/current at a version in one rename, so a Session never sees it missing.
promote() {
  local tool=$1 version=$2 tmp="$ROOT/$1/.current.$$"
  ln -sfn "$version" "$tmp"
  python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$tmp" "$ROOT/$tool/current"
}

# Removes versions nothing needs: not current, not among the newest KEEP, and replaced by a newer
# one more than GRACE_SECONDS ago. Each version's replacement time is when the next one arrived.
prune() {
  local tool=$1 current now dir version installed newer_at="" index=0
  current="$(current_of "$tool")"
  now="$(date +%s)"
  while IFS=' ' read -r installed version; do
    dir="$ROOT/$tool/$version"
    if [ "$index" -ge "$KEEP" ] && [ "$version" != "$current" ] && [ -n "$newer_at" ] && [ $((now - newer_at)) -gt "$GRACE_SECONDS" ]; then
      log "$tool: removing $version"
      rm -rf "$dir"
    fi
    newer_at="$installed"
    index=$((index + 1))
  done < <(for d in "$ROOT/$tool"/*/; do
    # `current` is a link to one of these, not a version of its own.
    if [ ! -L "${d%/}" ] && [ -f "$d$CHECKED" ]; then printf '%s %s\n' "$(cat "$d$CHECKED")" "$(basename "$d")"; fi
  done | sort -rn)
}

ensure() {
  local tool=$1 version=$2 pkg dir kept
  pkg="$(package_of "$tool")" || { log "unknown tool: $tool"; return 2; }
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "$tool: not a release version: $version"; return 2; }
  dir="$ROOT/$tool/$version"
  mkdir -p "$ROOT/$tool"

  # A directory without the marker is an install that died halfway or failed its checks.
  if [ -d "$dir" ] && [ ! -f "$dir/$CHECKED" ]; then rm -rf "$dir"; fi

  if [ ! -d "$dir" ]; then
    log "$tool: installing $pkg@$version"
    if ! npm install --global --prefix "$dir" --no-fund --no-audit --loglevel=error "$pkg@$version"; then
      rm -rf "$dir"
      log "$tool: npm could not install $version"
      return 1
    fi
    # Sessions run it as the agent user, so everything must be readable and every directory open.
    chmod -R a+rX "$dir"
    if ! check "$tool" "$dir"; then
      rm -rf "$dir"
      kept="$(current_of "$tool")"
      log "$tool: $version failed its checks, so Sessions stay on ${kept:-the version built into the image}"
      return 1
    fi
    date +%s >"$dir/$CHECKED"
  elif ! check "$tool" "$dir"; then
    # It passed once, but not against this image's entrypoint.
    if [ "$(current_of "$tool")" = "$version" ]; then
      rm -f "$ROOT/$tool/current"
      log "$tool: $version no longer passes this image's checks; Sessions use the built-in version"
    fi
    return 1
  fi

  promote "$tool" "$version"
  prune "$tool"
  log "$tool: $version is current"
}

case "${1:-}" in
  ensure) [ $# -eq 3 ] || { log "usage: kardboard-clis ensure <claude-code|codex> <version>"; exit 2; }; ensure "$2" "$3" ;;
  *) log "usage: kardboard-clis ensure <claude-code|codex> <version>"; exit 2 ;;
esac
