# Reaching kardboard

kardboard is at `https://minicore.saanen-monitor.ts.net:3071`, on the tailnet only, with no sign-in of its own; see [ADR 0014](../adr/0014-its-own-port-over-tailscale-https.md).

## How it is wired

Two pieces, both on minicore, with the same port number at each end:

1. The app container publishes port 3071 on the host's loopback only (`127.0.0.1:3071:3070` in `deploy/compose.yaml`). Nothing off the machine reaches that port.
2. Tailscale Serve listens on port 3071 of the tailnet name, with the tailnet's certificate, and proxies to the app. It was set up with `sudo tailscale serve --bg --https=3071 http://127.0.0.1:3071`, which persists across reboots. `tailscale serve status` lists it, and `sudo tailscale serve --https=3071 off` removes it.

Port 443, the bare `https://minicore.saanen-monitor.ts.net`, belongs to no app.

## When it does not load

Check from the inside out:

1. The app: on minicore, `curl http://127.0.0.1:3071/healthz` answers `{"ok":true,"db":"ok"}`. If it does not, run `docker compose ps` in `~/docker/stacks/kardboard` and read the app's log.
2. Serve: on minicore, `tailscale serve status` shows `https://minicore.saanen-monitor.ts.net:3071` proxying to `http://127.0.0.1:3071`.
3. The tailnet: from the device, `curl https://minicore.saanen-monitor.ts.net:3071/healthz`. If this fails while the first two pass, check that the device is on the tailnet with `tailscale status`.

Use the full name. The bare `minicore` is resolved through each machine's search domains in order. On agent-pc, `xode.cc` comes first, so `minicore` there is `minicore.xode.cc`, a Cloudflare address.

## Agents

An agent reaches the MCP server at `https://minicore.saanen-monitor.ts.net:3071/mcp` with its Access token, from any machine on the tailnet. The install commands in Settings → Agent use the address the page was opened at.

## The HSTS left over from the root address

For a few hours on 2026-10-07, the app at `https://minicore.saanen-monitor.ts.net` sent `Strict-Transport-Security: max-age=31536000; includeSubDomains`. A browser that saw it refuses plain http to every port of that name, such as invox's `http://…:3050`. The app now sends `max-age=0`, and HSTS is kept per host name, not per port, so opening kardboard at its address in that browser clears the old policy. To clear it by hand in Chrome, use "Delete domain security policies" at `chrome://net-internals/#hsts`.
