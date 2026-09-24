import { SESSION_KINDS, SESSION_STATUSES, type AdminSessionSummary, type SessionKind, type SessionStatus, type SessionUsage } from "@kardboard/shared";

// The decisions behind the Sessions tab, kept out of the component so they can be tested: which
// filters the address asks for, how long a run took, and how its usage reads.

export type StatusFilter = SessionStatus | "active" | "";

export type SessionsFilter = {
  board: string;
  status: StatusFilter;
  kind: SessionKind | "";
};

export const NO_FILTER: SessionsFilter = { board: "", status: "", kind: "" };

/** The filters in the page's address. A value the list does not know reads as no filter. */
export function filterFromParams(params: URLSearchParams): SessionsFilter {
  const status = params.get("status") ?? "";
  const kind = params.get("kind") ?? "";
  return {
    board: params.get("board") ?? "",
    status: status === "active" || (SESSION_STATUSES as readonly string[]).includes(status) ? (status as StatusFilter) : "",
    kind: (SESSION_KINDS as readonly string[]).includes(kind) ? (kind as SessionKind) : "",
  };
}

export function isFiltered(filter: SessionsFilter): boolean {
  return filter.board !== "" || filter.status !== "" || filter.kind !== "";
}

/** The address with `filter` in place of whatever it had, keeping anything else, such as `session`. */
export function paramsWithFilter(params: URLSearchParams, filter: SessionsFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ["board", "status", "kind"] as const) {
    if (filter[key]) next.set(key, filter[key]);
    else next.delete(key);
  }
  return next;
}

/** How long a run has taken, counting to now while it runs. Null before it started. */
export function sessionDurationMs(session: { startedAt: string | null; endedAt: string | null }, now: number): number | null {
  if (!session.startedAt) return null;
  const start = Date.parse(session.startedAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function totalTokens(usage: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/** One line for a run: turns, tokens, cost, each only when known. */
export function usageSummary(usage: SessionUsage): string {
  const parts: string[] = [];
  if (usage.numTurns !== null) parts.push(`${usage.numTurns} ${usage.numTurns === 1 ? "turn" : "turns"}`);
  parts.push(`${formatTokens(totalTokens(usage))} tokens`);
  if (usage.costUsd !== null) parts.push(formatCost(usage.costUsd));
  return parts.join(" · ");
}

/** The token counts behind the total, for a tooltip. */
export function usageBreakdown(usage: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">): string {
  return [
    `${formatTokens(usage.inputTokens)} input`,
    `${formatTokens(usage.outputTokens)} output`,
    `${formatTokens(usage.cacheReadTokens)} cache read`,
    `${formatTokens(usage.cacheCreationTokens)} cache write`,
  ].join(", ");
}

/**
 * A Session linked to by id is shown in its place in the list when it is on a loaded page. When it is
 * older than those, or outside the filters, it is shown on its own above the list instead.
 */
export function linkedOutsideList(sessions: AdminSessionSummary[], linked: AdminSessionSummary | null | undefined): AdminSessionSummary | null {
  if (!linked) return null;
  return sessions.some((s) => s.id === linked.id) ? null : linked;
}
