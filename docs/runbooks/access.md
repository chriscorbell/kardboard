# Reaching kardboard

kardboard is a plain port on minicore, like the other apps there, with no sign-in of its own; see [ADR 0014](../adr/0014-a-plain-port-like-the-other-apps.md).

## How it is wired

- The app listens on 3070 inside its container and is published on host port 3071, on every interface (`3071:3070` in `deploy/compose.yaml`). `ufw` is inactive on minicore, so the port is open to the home network and the tailnet.
- From any tailnet device it is `http://minicore.saanen-monitor.ts.net:3071`; on the home network, `http://10.0.0.20:3071` as well.
- Use the full tailnet name. The bare `minicore` is resolved through each machine's search domains in order, and on agent-pc `xode.cc` comes first, so `minicore` there is `minicore.xode.cc`, a Cloudflare address (found 2026-10-07).
- Nothing routes the public internet to it. The Cloudflare tunnel in fleet's `stacks/cloudflared` routes hostnames to `10.0.0.20` plus a port, set in the Cloudflare dashboard; no route may ever target 3071. The `kardboard.cc` routes to 3070 and 3073 are left over from before 2026-10-07 and reach nothing.

## Agents

An agent reaches the MCP server at `http://minicore.saanen-monitor.ts.net:3071/mcp` with its Access token, from any machine on the tailnet. The install commands in Settings → Agent use the address the page was opened at.

## The HSTS left over from Tailscale Serve

From 2026-10-07, for a few hours, the app ran behind Tailscale Serve at `https://minicore.saanen-monitor.ts.net` and sent `Strict-Transport-Security: max-age=31536000; includeSubDomains`. A browser that loaded it there refuses plain http to `minicore.saanen-monitor.ts.net` on every port, invox's 3050 included, until 2027-10. The app now sends `max-age=0`, which clears that, but only over https. So Serve went on proxying `https://minicore.saanen-monitor.ts.net` to the app (`sudo tailscale serve --bg 3071`) until each browser that saw kardboard there had opened it once, and was then turned off with `sudo tailscale serve --https=443 off`.

A browser that still turns `http://minicore.saanen-monitor.ts.net:3071` into https holds the old policy. In Chrome, delete it under "Delete domain security policies" at `chrome://net-internals/#hsts`. In Safari, on a Mac or an iPhone, clearing its history and website data does it.

## When it does not load

- `curl http://minicore.saanen-monitor.ts.net:3071/healthz` from a tailnet device answers `{"ok":true,"db":"ok"}` when the app is up. On minicore, `curl http://127.0.0.1:3071/healthz`.
- A renamed tailnet changes the address. Update every agent's MCP URL, and the address in this runbook, the design, and the compose file's header.
