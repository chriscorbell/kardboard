---
status: accepted
date: 2026-10-07
---
# kardboard has its own port on minicore, over Tailscale HTTPS, with no sign-in

[ADR 0013](0013-tailscale-is-the-sign-in.md) put kardboard behind Tailscale Serve at the root of minicore's tailnet name, `https://minicore.saanen-monitor.ts.net`, and took the tailnet login Serve vouched for as its sign-in. That gave the machine's own name to one app. The User wants each self-hosted app on its own port, reachable only on the tailnet, over Tailscale's HTTPS, and simple to troubleshoot. So kardboard has two pieces, both on minicore, with the same port number at each end. The container publishes port 3071 on the host's loopback only. Tailscale Serve listens on port 3071 of the tailnet name and proxies to it with the tailnet's certificate: `https://minicore.saanen-monitor.ts.net:3071`. Port 443, the bare name, belongs to no app. There is no sign-in: the tailnet is the boundary. Agents keep their Access tokens, which is how the Board tells their work from the User's.

## Considered options

- **Serve at the root, with the tailnet login as the sign-in** (ADR 0013). It takes the machine's name, and adds a sign-in to troubleshoot for one person.
- **Plain http on every interface**, as kardboard ran for an hour on 2026-10-07 and as invox still runs. The home network reaches it too, there is no HTTPS, and a browser gives a plain-http page no clipboard.

## Consequences

- Every device on the tailnet reaches kardboard and is the User, as is any process on minicore. Nothing on the home network or the public internet reaches it. The Cloudflare tunnel, which routes to `10.0.0.20`, cannot reach a loopback port.
- Troubleshooting goes from the inside out. `curl http://127.0.0.1:3071/healthz` on minicore checks the app, `tailscale serve status` shows the mapping, and `curl https://minicore.saanen-monitor.ts.net:3071/healthz` from a tailnet device checks the whole path.
- The app sends `Strict-Transport-Security: max-age=0`. An HSTS policy covers every port of a host name, and other apps on minicore may still serve plain http. While ADR 0013 held, the app sent a year of HSTS with `includeSubDomains`. A browser that saw it forgets it the first time it opens kardboard at its new address, since HSTS is kept per host name, not per port.
- Agents reach `/mcp` at `https://minicore.saanen-monitor.ts.net:3071/mcp`. The bare name `minicore` is not used, because a machine's other search domains can claim it first.
- ADR 0013 is superseded.
