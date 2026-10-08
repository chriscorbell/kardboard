---
status: accepted
date: 2026-10-07
---
# kardboard is a plain port on minicore, like the other apps there, with no sign-in

[ADR 0013](0013-tailscale-is-the-sign-in.md) put kardboard behind Tailscale Serve at `https://minicore.saanen-monitor.ts.net` and took the tailnet login Serve vouched for as its sign-in. That gave the machine's own tailnet name to one app, so the address of minicore became the address of kardboard. The User's other self-hosted apps on minicore, such as invox, are each a published host port with no sign-in of their own, reached from the home network and the tailnet and never from the public internet. kardboard now runs the same way. The container publishes host port 3071, the app takes every request as the User, and it is reached at `http://minicore.saanen-monitor.ts.net:3071`, or at minicore's LAN address on the home network. The network is the boundary. Agents keep their Access tokens, which is how the Board tells their work from the User's.

## Considered options

- **Keep Serve on a port of its own** (`tailscale serve --https=3071`). That frees the machine's name and keeps https and the identity check, but kardboard would still be the one app on minicore reached and secured differently from the rest, which is what the User asked to undo.
- **Keep an identity check without Serve.** Without Serve, no header carries the tailnet login, so there is nothing to check.
- **Host port 3070.** kardboard always used it, but the Cloudflare tunnel that served `kardboard.cc` may still route the public internet to `10.0.0.20:3070`. An app with no sign-in must not sit on that port while the route could exist.

## Consequences

- Anything that reaches port 3071 on minicore is the User: every device on the home network and the tailnet, and every container on minicore. The other apps there are trusted the same way.
- No Cloudflare tunnel route may ever target port 3071.
- The app is served over plain http. The browser offers no `navigator.clipboard` there, so the copy buttons fall back to the older copy command.
- While ADR 0013 held, the app sent a year of HSTS with `includeSubDomains` from `https://minicore.saanen-monitor.ts.net`. A browser that saw it refuses plain http to every port on minicore, the other apps' included. The app now sends `max-age=0` instead, and a browser forgets the old policy once it opens the https address again. [The access runbook](../runbooks/access.md) says how that address was kept up for the purpose, and how to clear a browser by hand.
- Agents reach `/mcp` at `http://minicore.saanen-monitor.ts.net:3071/mcp`. The bare name `minicore` is not used, because a machine's other search domains can claim it first.
- ADR 0013 is superseded.
