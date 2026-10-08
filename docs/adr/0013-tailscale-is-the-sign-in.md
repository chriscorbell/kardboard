---
status: accepted
date: 2026-10-07
---
# kardboard is reached over Tailscale, and Tailscale is the sign-in

kardboard was public at `kardboard.cc`, behind a Cloudflare Tunnel, with Clerk for sign-in ([ADR 0001](0001-clerk-for-identity-with-local-allowlist.md)) and Resend for email, because clients signed in from anywhere. Since [ADR 0011](0011-one-persons-board-worked-by-their-own-agents.md) the only person is the User, and every device they and their agents use is already on their tailnet. So the app is reached only over Tailscale. It listens on minicore's loopback alone, and Tailscale Serve on the host puts it at `https://minicore.saanen-monitor.ts.net` with the tailnet's certificate. Serve adds the identity of the tailnet user behind each request, `Tailscale-User-Login`, and removes any such header the client sent, so the app takes that header as the sign-in and lets in the one login it is configured with. Clerk and Resend are removed. A failed backup, which used to be emailed, shows on the Overview until the next one succeeds.

## Considered options

- **Keep Clerk behind Tailscale.** Clerk's production instance works only on its own domain, so it would need a public domain anyway, and a second sign-in on top of the tailnet's adds nothing for one person.
- **No sign-in, the tailnet alone.** Simpler, but the app would trust the network rather than an identity, and anything that reached its port, such as another container or a LAN device, would be the User. Binding to loopback behind Serve, and checking the login Serve vouches for, costs one header check.
- **Keep the public domain alongside.** Two ways in, two sign-ins to keep secure, for access from a device not on the tailnet, which the User does not need.

## Consequences

- Every device on the tailnet that is signed in as the User is the User, agents' machines included. A tagged device gets no identity headers and is turned away.
- Agents keep their Access tokens and reach `/mcp` at the tailnet address. An agent running outside the tailnet, such as a cloud agent, cannot reach kardboard.
- `kardboard.cc`, its Cloudflare Tunnel route, the Clerk instance, and the Resend domain are no longer used; removing them is the User's step.
- ADR 0001 is superseded.
