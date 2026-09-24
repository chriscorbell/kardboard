import type http from "node:http";

// A Provider's usage window belongs to the subscription, not to one Session: every concurrent Session
// and the Admin's own interactive use draw on the same window (ADR 0002). The proxy is the only part
// of the stack that sees the provider's own answer, so it is where a usage limit is observed. It
// keeps the last refusal per Provider in memory and the app reads it back from `/limits`.
//
// In memory on purpose: a usage window is minutes to hours long and a restarted proxy simply learns
// again from the next refusal. Nothing here is worth a database. The same goes for a rejected
// credential: a new Claude token restarts the proxy, and a replaced Codex sign-in file clears the
// failure on the next turn that goes through.

export type Provider = "claude" | "codex";

export interface UsageLimit {
  /** When the proxy saw the provider refuse a request for want of usage, ISO 8601. */
  at: string;
  /** When the provider said the window reopens, ISO 8601, or null when it did not say. */
  until: string | null;
}

export type LimitSnapshot = Record<Provider, UsageLimit | null>;

/** A provider refusing the credential this proxy holds, rather than the request it carried. */
export interface AuthFailure {
  /** When it was seen, ISO 8601. */
  at: string;
  /** The provider's status, or null when the credential failed before any request went out. */
  status: number | null;
  /** What failed, in words safe to show the Admin: never a token, never a response body. */
  reason: string;
}

/** A call a Session asked for that is not on the allowlist, so it never left the proxy. */
export interface RefusedCall {
  at: string;
  provider: Provider;
  method: string;
  path: string;
}

/**
 * Everything the app reads from `/limits`. The two Provider keys stay at the top level, where they
 * always were, so an app that knows only about usage limits still reads this; the rest is for the
 * Admin panel and its alerts.
 */
export type ProxyReport = LimitSnapshot & {
  authFailures: Record<Provider, AuthFailure | null>;
  refusals: { count: number; last: RefusedCall | null };
};

/** A refusal for want of usage. 429 is the only status either provider uses for one. */
export function isUsageLimit(status: number | undefined): boolean {
  return status === 429;
}

/** The provider did not accept the credential. 401 and 403 are what both use for that. */
export function isAuthFailure(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** Longest window we will believe. A malformed header must not park a Provider for a year. */
const MAX_WINDOW_MS = 24 * 3_600_000;

function one(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return one(value[0]);
  return null;
}

function within(atMs: number, nowMs: number): string | null {
  if (!Number.isFinite(atMs)) return null;
  if (atMs <= nowMs || atMs > nowMs + MAX_WINDOW_MS) return null;
  return new Date(atMs).toISOString();
}

/**
 * When the provider said the window reopens. Two headers are read, both of which the providers send
 * on a 429: Anthropic's unified reset, which is unix seconds, and `retry-after` from RFC 9110, which
 * is either delta-seconds or an HTTP date. Anything else is treated as "it did not say".
 */
export function resetAt(headers: http.IncomingHttpHeaders, nowMs: number): string | null {
  const unified = one(headers["anthropic-ratelimit-unified-reset"]);
  if (unified && /^\d+$/.test(unified)) {
    const parsed = within(Number(unified) * 1000, nowMs);
    if (parsed) return parsed;
  }
  const retry = one(headers["retry-after"]);
  if (retry) {
    if (/^\d+$/.test(retry)) return within(nowMs + Number(retry) * 1000, nowMs);
    return within(Date.parse(retry), nowMs);
  }
  return null;
}

/**
 * The last usage refusal seen per Provider, and the other things only the proxy can see: a provider
 * rejecting the credential, and the calls it refused to forward. One instance per process; the proxy
 * writes, /limits reads.
 */
export class UsageLimits {
  private seen = new Map<Provider, UsageLimit>();
  private authFailures = new Map<Provider, AuthFailure>();
  private refusedCount = 0;
  private lastRefused: RefusedCall | null = null;

  note(provider: Provider, headers: http.IncomingHttpHeaders, nowMs = Date.now()): UsageLimit {
    const limit: UsageLimit = { at: new Date(nowMs).toISOString(), until: resetAt(headers, nowMs) };
    this.seen.set(provider, limit);
    return limit;
  }

  noteAuthFailure(provider: Provider, status: number | null, reason: string, nowMs = Date.now()): AuthFailure {
    const failure: AuthFailure = { at: new Date(nowMs).toISOString(), status, reason };
    this.authFailures.set(provider, failure);
    return failure;
  }

  /**
   * A turn went through, so the credential works again: a replaced Codex sign-in file, or a refusal
   * that was the provider's passing trouble. What the Admin is shown is whether it is failing now.
   */
  noteAccepted(provider: Provider): void {
    this.authFailures.delete(provider);
  }

  noteRefused(provider: Provider, method: string, path: string, nowMs = Date.now()): RefusedCall {
    const call: RefusedCall = { at: new Date(nowMs).toISOString(), provider, method, path: path.slice(0, 200) };
    this.refusedCount++;
    this.lastRefused = call;
    return call;
  }

  snapshot(): LimitSnapshot {
    return { claude: this.seen.get("claude") ?? null, codex: this.seen.get("codex") ?? null };
  }

  report(): ProxyReport {
    return {
      ...this.snapshot(),
      authFailures: { claude: this.authFailures.get("claude") ?? null, codex: this.authFailures.get("codex") ?? null },
      refusals: { count: this.refusedCount, last: this.lastRefused },
    };
  }
}
