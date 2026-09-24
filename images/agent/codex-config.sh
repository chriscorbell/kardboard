# The config.toml a Codex Session runs with, printed to stdout. Sourced by the entrypoint, and by
# kardboard-clis to check a newly released Codex against exactly this before any Session runs it.
# Reads KARDBOARD_MCP_URL, and KARDBOARD_CODEX_EGRESS_URL when inference goes through the proxy.
codex_config() {
  if [ -n "${KARDBOARD_CODEX_EGRESS_URL:-}" ]; then
    # A named model provider is what puts Codex on the proxy: the default provider prefers a
    # WebSocket to chatgpt.com that ignores any base URL, and naming one turns that transport
    # off. `requires_openai_auth` keeps Codex in subscription mode; the proxy holds the token.
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
}
