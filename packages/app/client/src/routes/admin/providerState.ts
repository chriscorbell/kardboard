import type { ProviderStatus } from "@kardboard/shared";

/** A wait to the minute: a reopening time does not need seconds. */
export function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in about a minute";
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// How the Agent tab sums up one Provider from what the egress proxy last saw. A rejected credential
// outranks a usage window, since it will not reopen on its own.

export interface ProviderState {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  /** When a usage window reopens, still ahead; the component formats it in local time. */
  reopensAt: string | null;
  /** "in 42m", alongside `reopensAt`. */
  reopensIn: string | null;
}

export function providerState(status: ProviderStatus, now: number): ProviderState {
  if (status.credentialLoaded === false) return { tone: "neutral", label: "No credential", reopensAt: null, reopensIn: null };
  if (status.authFailure) return { tone: "danger", label: "Credential rejected", reopensAt: null, reopensIn: null };
  const until = status.limit?.until ? Date.parse(status.limit.until) : Number.NaN;
  if (Number.isFinite(until) && until > now) {
    return { tone: "warn", label: "Out of usage", reopensAt: status.limit!.until, reopensIn: formatWait(until - now) };
  }
  return { tone: "ok", label: "Available", reopensAt: null, reopensIn: null };
}
