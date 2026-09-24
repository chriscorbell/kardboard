#!/usr/bin/env bash
# Session entrypoint. The runner passes configuration in the environment and the workflow prompt
# on stdin. The agent reaches kardboard through MCP with the session token and the provider
# through the egress proxy. Exit code 0 means the agent finished on its own terms.
set -euo pipefail

: "${KARDBOARD_SESSION_ID:?}" "${KARDBOARD_TOKEN:?}" "${KARDBOARD_MCP_URL:?}" "${KARDBOARD_PROVIDER:?}"
PROMPT="$(cat)"
WALL_CLOCK_MINUTES="${KARDBOARD_WALL_CLOCK_MINUTES:-45}"

log() { printf '[session %s] %s\n' "$KARDBOARD_SESSION_ID" "$*" >&2; }

# The runner mounts the Board's dependency cache at /cache and the image points every package tool
# into it. A volume first created by an image without a /cache of its own belongs to root; rather
# than fail every install on it, the tools fall back to their defaults for this Session.
if [ ! -w /cache ]; then
  log "/cache is not writable, so package caches stay inside this container"
  unset npm_config_cache pnpm_config_store_dir pnpm_config_cache_dir BUN_INSTALL_CACHE_DIR GOMODCACHE GOCACHE UV_CACHE_DIR PIP_CACHE_DIR
fi

if [ -n "${KARDBOARD_REPO_URL:-}" ]; then
  log "cloning $KARDBOARD_REPO_URL"
  # Blobless rather than shallow: every commit of the default branch, with file contents fetched as
  # git needs them. A --depth clone could not merge the default branch into a card's branch once the
  # two had diverged by more than the depth, and every Session's workflow asks for that merge. The
  # lazy fetches use the credential helper written into the repository below.
  # GITHUB_TOKEN is a one-hour installation token the app mints from the Sessions GitHub App. It is
  # absent only when that app is not configured, and then the clone is anonymous.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f' clone --filter=blob:none --single-branch "$KARDBOARD_REPO_URL" repo
    git -C repo config credential.helper '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'
  else
    git clone --filter=blob:none --single-branch "$KARDBOARD_REPO_URL" repo
  fi
  cd repo
  git config user.name "${KARDBOARD_GIT_NAME:-Milo}"
  git config user.email "${KARDBOARD_GIT_EMAIL:-kardboard@users.noreply.github.com}"
  if [ -n "${KARDBOARD_BRANCH:-}" ]; then
    # A single-branch clone only has the default branch, so ask origin whether the card's branch exists.
    # Only a definite "no" starts it fresh: treating any failed fetch as "no" cut a new branch from
    # the default one, and the Session worked without the commits already on the real branch.
    status=0
    git ls-remote --exit-code --heads origin "refs/heads/$KARDBOARD_BRANCH" >/dev/null || status=$?
    case "$status" in
      0)
        log "resuming existing branch $KARDBOARD_BRANCH"
        if ! git fetch origin "refs/heads/$KARDBOARD_BRANCH:refs/remotes/origin/$KARDBOARD_BRANCH"; then
          log "branch $KARDBOARD_BRANCH exists on origin but could not be fetched; stopping rather than starting it over"
          exit 1
        fi
        git checkout -B "$KARDBOARD_BRANCH" "origin/$KARDBOARD_BRANCH"
        ;;
      2)
        log "starting new branch $KARDBOARD_BRANCH"
        git checkout -b "$KARDBOARD_BRANCH"
        ;;
      *)
        log "could not ask origin whether $KARDBOARD_BRANCH exists (git ls-remote exited $status); stopping rather than starting it over"
        exit 1
        ;;
    esac
  fi
fi

case "$KARDBOARD_PROVIDER" in
  claude)
    log "starting claude code"
    cat > /tmp/mcp.json <<JSON
{ "mcpServers": { "kardboard": { "type": "http", "url": "$KARDBOARD_MCP_URL", "headers": { "Authorization": "Bearer $KARDBOARD_TOKEN" } } } }
JSON
    MODEL_ARGS=(); [ -n "${KARDBOARD_MODEL:-}" ] && MODEL_ARGS=(--model "$KARDBOARD_MODEL")
    # Effort level: Claude Code reads CLAUDE_CODE_EFFORT_LEVEL (low, medium, high, max).
    [ -n "${KARDBOARD_REASONING:-}" ] && export CLAUDE_CODE_EFFORT_LEVEL="$KARDBOARD_REASONING"
    # stream-json, not text: text prints nothing until the run ends, so the container log — which is
    # what the admin panel shows as the Session's transcript — would stay empty for the whole run.
    # Planning and subagents: TodoWrite is deprecated in favour of the Task* tools, and Agent was
    # called Task before Claude Code 2.1.63. The image does not pin Claude Code, so both generations
    # are listed; these are permission rules, and a name a version lacks simply matches nothing.
    exec timeout --signal=TERM "${WALL_CLOCK_MINUTES}m" \
      claude -p "$PROMPT" "${MODEL_ARGS[@]}" \
        --mcp-config /tmp/mcp.json \
        --permission-mode acceptEdits \
        --allowedTools "mcp__kardboard__*,Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate,Agent,Task" \
        --output-format stream-json --verbose
    ;;
  codex)
    log "starting codex"
    export CODEX_HOME="$HOME/.codex"
    mkdir -p "$CODEX_HOME"; chmod 700 "$CODEX_HOME"

    # The runner gives the Session exactly one credential path (see packages/runner/src/codex.ts).
    if [ -n "${KARDBOARD_CODEX_AUTH_STAGE:-}" ]; then
      # Copy rather than read the mount in place: Codex rewrites auth.json whenever it refreshes
      # its access token, and the mount is read-only so the Admin's file is never changed here.
      log "using the mounted codex sign-in file"
      install -m 600 "$KARDBOARD_CODEX_AUTH_STAGE" "$CODEX_HOME/auth.json"
    fi

    {
      if [ -n "${KARDBOARD_CODEX_EGRESS_URL:-}" ]; then
        # A named model provider is what puts Codex on the proxy: the default provider prefers a
        # WebSocket to chatgpt.com that ignores any base URL, and naming one turns that transport
        # off. `requires_openai_auth` keeps Codex in subscription mode; the proxy holds the token.
        log "sending codex inference through the egress proxy"
        cat <<TOML
model_provider = "kardboard"

[model_providers.kardboard]
name = "kardboard egress"
base_url = "$KARDBOARD_CODEX_EGRESS_URL"
wire_api = "responses"
requires_openai_auth = true

TOML
      fi
      # Verified against codex-cli 0.154.0: this is what `codex mcp add --url --bearer-token-env-var`
      # writes, and it keeps the Session token in the environment instead of on disk.
      cat <<TOML
[mcp_servers.kardboard]
url = "$KARDBOARD_MCP_URL"
bearer_token_env_var = "KARDBOARD_TOKEN"
TOML
    } > "$CODEX_HOME/config.toml"

    # --strict-config makes Codex fail on a key it does not recognise. A Session that cannot be
    # configured should stop loudly; silently ignored config is how this path broke before.
    CODEX_ARGS=(--strict-config --skip-git-repo-check)
    [ -n "${KARDBOARD_MODEL:-}" ] && CODEX_ARGS+=(-m "$KARDBOARD_MODEL")
    # Codex calls the top level "xhigh"; kardboard's "max" maps to it.
    if [ -n "${KARDBOARD_REASONING:-}" ]; then
      EFFORT="$KARDBOARD_REASONING"; [ "$EFFORT" = "max" ] && EFFORT="xhigh"
      CODEX_ARGS+=(-c "model_reasoning_effort=\"$EFFORT\"")
    fi
    # `--full-auto` was removed in codex-cli 0.154 and Codex exits 2 on it. The Session container is
    # itself the sandbox, which is the case this flag documents. stdin is already at EOF after the
    # prompt was read; closing it explicitly stops Codex waiting for more input.
    exec timeout --signal=TERM "${WALL_CLOCK_MINUTES}m" \
      codex exec --dangerously-bypass-approvals-and-sandbox "${CODEX_ARGS[@]}" "$PROMPT" < /dev/null
    ;;
  *)
    log "unknown provider $KARDBOARD_PROVIDER"; exit 64 ;;
esac
