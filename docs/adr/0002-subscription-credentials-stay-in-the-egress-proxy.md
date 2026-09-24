---
status: accepted
date: 2026-09-13
---
# Provider credentials live only in the egress proxy

Sessions run on the Admin's personal Claude Code and Codex subscriptions rather than API keys, so the credential is one long-lived, high-value token rather than a revocable per-project key. Sessions also execute text written by clients, which makes prompt injection inside a container a realistic path to exfiltration. We therefore never place the Claude Code token in a Session container: containers talk to the provider through an egress proxy in the kardboard stack that injects the credential on requests bound for the provider's endpoints. Codex uses its sign-in file injected into the container until the same proxy path is verified for it; the proxy route exists and is off by default.

## Status of verification

Codex verified 2026-09-15 on minicore: with `KARDBOARD_CODEX_VIA_EGRESS=1` a Session container holding no Codex credential completed a turn through the proxy against the ChatGPT backend and replied on the card. The Codex exception below is closed; both Providers now keep their credential in the proxy.

Claude, verified 2026-09-14 on minicore: a container on the workload network with no credential called `/v1/messages` through the proxy and received a model reply.

## Consequences

- The credential reaches the Admin's whole account, not only inference: ChatGPT conversations and profile, Anthropic organisation settings and usage. Since 2026-09-24 the proxy forwards only the calls each CLI makes to run a turn, listed by method and path in `ALLOWED_CALLS` in `packages/egress/src/proxy.ts`, and refuses dot segments and encoded separators outright. Anything else is a 403 with a `refused` line in the egress log, which is also where a CLI upgrade that needs a new endpoint first shows up.
- For a proxied Provider, a compromised Session can burn subscription usage during its 45-minute life but cannot carry the token out. The guarantee does not hold for a Codex Session started with the sign-in file mounted instead, which is now only the fallback wiring for a host that has not been given the proxy route.
- Automatic fallback between the Providers is on by default as of 2026-09-15. The verification above is what allows it: both Providers keep their credential in the proxy, so moving a Card from one to the other no longer drops it into a weaker credential mode. The Admin can turn it off in the admin panel, and a host still running Codex with a mounted sign-in file should, because falling into Codex there does put a credential inside the container.
- The Codex sign-in file must come from a `codex login` made for kardboard alone, never a copy of the Admin's own working `~/.codex/auth.json`. OpenAI refresh tokens are single-use ([openai/codex#6036](https://github.com/openai/codex/issues/6036), [#6498](https://github.com/openai/codex/issues/6498)): when two Codex clients share one sign-in, whichever refreshes second is refused and stays signed out until someone logs in again. A copy of the Admin's file would put the proxy and the Admin's own Codex in that race.
- In the mounted fallback a Session never writes to the host's sign-in file: it is bound read-only at a staging path and copied into the container, because Codex rewrites the file whenever it refreshes its access token. That keeps the host file intact but does not keep it working. A Session that refreshes spends the refresh token the host copy still holds, so the next refresh from that copy, by another Session or the proxy, fails. The mounted fallback lasts only until the first refresh inside a Session, which is a further reason the proxy route is the production setting. An earlier version of this record called that divergence harmless; it is not.
- Subscription usage windows are shared by every concurrent Session and the Admin's interactive use, which is why the global concurrency cap exists and why Providers fall back to each other on usage-limit errors.
