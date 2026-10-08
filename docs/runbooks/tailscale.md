# Reaching kardboard over Tailscale

kardboard is reached only over the tailnet, at `https://minicore.saanen-monitor.ts.net`, and Tailscale is its sign-in; see [ADR 0013](../adr/0013-tailscale-is-the-sign-in.md).

## How it is wired

- The app container publishes port 3070 on minicore's loopback only (`127.0.0.1:3070:3070` in `deploy/compose.yaml`), so nothing on the LAN, and no other container, reaches it.
- Tailscale Serve on minicore proxies `https://minicore.saanen-monitor.ts.net` to `http://127.0.0.1:3070`, with the certificate Tailscale issues for the tailnet (HTTPS Certificates is on in the tailnet's DNS settings). Set up on 2026-10-07 with `sudo tailscale serve --bg 3070`, which persists across reboots; `tailscale serve status` shows it, and `sudo tailscale serve --https=443 off` removes it.
- Serve adds `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic` to every request from a user's device, and removes any such header the client sent (checked on 2026-10-07: a request carrying a made-up `Tailscale-User-Login` arrived with the real one). The app lets in `KARDBOARD_TAILSCALE_LOGIN`, `chriscorbell@github` in production, and takes the User's name and avatar from the other two. A request without the header gets 401, another login 403.
- Requests from a tagged device carry no identity headers. On 2026-10-07 no device on the tailnet was tagged.

## Agents

An agent reaches the MCP server at `https://minicore.saanen-monitor.ts.net/mcp` with its Access token, from any machine on the tailnet. The install commands in Settings → Agent use the address the page was opened at.

## When it does not load

- `curl https://minicore.saanen-monitor.ts.net/healthz` from a tailnet device answers `{"ok":true,"db":"ok"}` when Serve and the app are both up. On minicore, `curl http://127.0.0.1:3070/healthz` checks the app alone.
- "Open kardboard through Tailscale" in the browser: the request reached the app without identity headers. Check it came through Serve, not the port directly.
- "This Tailscale account isn't the one": the device is signed in to Tailscale as another login, or the login changed; set `KARDBOARD_TAILSCALE_LOGIN` in the stack's `.env` and `docker compose up -d`.
- A renamed tailnet changes the address. Update `KARDBOARD_PUBLIC_URL` in `deploy/compose.yaml` and in fleet, and every agent's MCP URL.
