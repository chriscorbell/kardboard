import type { Provider, SessionStatus } from "@kardboard/shared";
import type { LimitSnapshot, UsageLimit } from "./provider-limits.js";

// When a Provider runs out of subscription usage, the Card's work should continue on the other one
// rather than the Session simply failing. The whole policy is here, as plain functions over what the
// egress proxy saw, so it can be reasoned about and tested without a database or a container.
//
// Two rules, and both are deliberately narrow.
//
//   Starting   Skip a Provider only when it said when its window reopens and that moment is still
//              ahead. A refusal that named no window is not enough to route around: the window may
//              have reopened seconds later, and guessing would strand a Board on the wrong Provider.
//
//   Failing    Fall back only when the Session actually failed and the Provider refused it for want
//              of usage while it was running. A 429 the CLI retried through never reaches this,
//              because the Session then succeeds — which is why the rule does not have to tell a
//              short throttle from an exhausted subscription.

export function otherProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude";
}

/** Out of usage right now, as far as the provider itself said. */
export function limitedNow(limit: UsageLimit | null, nowMs: number): boolean {
  if (!limit?.until) return false;
  const until = Date.parse(limit.until);
  return Number.isFinite(until) && until > nowMs;
}

/** Refused for want of usage while this Session was running. */
export function limitedDuring(limit: UsageLimit | null, since: string | null): boolean {
  if (!limit || !since) return false;
  const at = Date.parse(limit.at);
  const from = Date.parse(since);
  return Number.isFinite(at) && Number.isFinite(from) && at >= from;
}

/**
 * The Provider to start a new Session on. `switched` is true when this is not the Board's Provider,
 * which is worth an event on the Card so a person can see why the run looks different.
 */
export function providerForDispatch(input: {
  enabled: boolean;
  preferred: Provider;
  limits: LimitSnapshot;
  nowMs: number;
}): { provider: Provider; switched: boolean } {
  const other = otherProvider(input.preferred);
  const avoid = input.enabled && limitedNow(input.limits[input.preferred], input.nowMs) && !limitedNow(input.limits[other], input.nowMs);
  return avoid ? { provider: other, switched: true } : { provider: input.preferred, switched: false };
}

/**
 * The Provider to pick the Card up again on after a Session ended, or null to leave it ended. The
 * Session must have failed, must not already be a fallback — one hop, never a loop — and the other
 * Provider must not be out of usage itself.
 */
export function providerAfterFailure(input: {
  enabled: boolean;
  status: SessionStatus;
  provider: Provider;
  fallbackFrom: Provider | null;
  /** When the Session began. Its own start, or its creation when it never got that far. */
  since: string | null;
  limits: LimitSnapshot;
  nowMs: number;
}): Provider | null {
  if (!input.enabled || input.status !== "failed" || input.fallbackFrom) return null;
  if (!limitedDuring(input.limits[input.provider], input.since)) return null;
  const other = otherProvider(input.provider);
  return limitedNow(input.limits[other], input.nowMs) ? null : other;
}
