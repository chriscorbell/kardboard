# A provider's usage limit is only visible in the egress proxy

Read when: changing Provider fallback, touching the egress proxy's `/limits` route, or working out why a Card did or did not move to the other Provider.
Status: verified
Scope: `packages/egress`, `packages/app/server/src/services/{fallback,provider-limits,orchestrator,sweep}.ts`
Verified: 2026-09-15, by the tests in `packages/egress/test/limits.test.ts` and `packages/app/server/test/fallback.test.ts`; unobserved against a real refusal.
Recheck when: a Provider stops going through the proxy, or a provider starts signalling exhaustion with something other than HTTP 429.
Source: [design.md](../../design.md#providers-and-credentials), [ADR 0002](../../adr/0002-subscription-credentials-stay-in-the-egress-proxy.md)

Nothing else in the stack can see a usage limit. Session containers hold no credential, so the refusal happens on the proxy's connection; the runner only sees an exit code, and the CLI's own wording for exhaustion has changed between releases (see [the Codex lesson](../lessons/codex-cli-drifts-between-releases.md)). Detect on the HTTP status: 429 and only 429, which is version-independent. Do not match on log text — this repository's own card titles contain the phrase "usage limit", so a substring rule reports a limit whenever an agent reads the board.

Consequences that are easy to trip over:

- The proxy's memory of a refusal is a `Map` in the process, not a row. Restarting the egress container forgets every window, and the app's response to that is to behave as though no Provider is limited. That is the intended failure direction: `readProviderLimits` never throws and returns "nothing seen" for a timeout, a bad body, or an unset `KARDBOARD_EGRESS_URL`.
- `/limits` is guarded by `EGRESS_CONTROL_TOKEN`, which `deploy/compose.yaml` sets to `KARDBOARD_RUNNER_TOKEN`. That reuse is deliberate and load-bearing: Session containers are on the `workload` network and can reach the proxy, and they are the one thing that never holds the runner token.
- Pre-emptive avoidance fires only on a refusal that *named* a reopening time still ahead. A 429 with no `retry-after` and no `anthropic-ratelimit-unified-reset` may have reopened a second later, so it does not route a new Session away — but it does count as a reason to fall back after a Session that actually failed.
- A Codex Session started with the sign-in file mounted (no `KARDBOARD_CODEX_VIA_EGRESS`) talks to the provider directly. Its refusals never reach the proxy, so fallback out of Codex cannot work on such a host, and fallback *into* it would put a credential in a container. Turn the Admin setting off there.
