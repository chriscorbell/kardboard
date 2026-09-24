import { desc, eq, gte, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import type { BoardUsageTotal, SessionUsage, UsageTotalsView } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { runner } from "./runner-client.js";
import { splitLogLine } from "./transcript.js";

// What a Session used, read once when it ends. Claude Code finishes a `-p` run in stream-json with a
// single `result` event carrying the whole run's token counts, its cost at API prices, its turns,
// and its duration; it is the last line the CLI writes. The log itself is pruned after 14 days, so
// the numbers are copied onto the Session's row where they outlive it.
//
// Codex is run without `--json`, so its log is plain text with nothing to read here, and a Codex
// Session records no usage.

const READ_ATTEMPTS = 4;
// The runner reports an exit as soon as the container stops, and may still be writing the log's
// last lines to disk at that moment.
const READ_WAIT_MS = Number(process.env.KARDBOARD_USAGE_READ_WAIT_MS ?? "1500");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const tokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The usage in one `result` event. `modelUsage` is summed when it is there: it breaks the run down
 * per model, including the small model Claude Code uses on the side, which the top-level `usage`
 * may leave out. The top-level cost already covers every model.
 */
export function usageFromResult(event: Record<string, unknown>): SessionUsage {
  const perModel = Object.values(asRecord(event.modelUsage) ?? {})
    .map(asRecord)
    .filter((m): m is Record<string, unknown> => m !== null);
  const counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  if (perModel.length > 0) {
    for (const m of perModel) {
      counts.inputTokens += tokens(m.inputTokens);
      counts.outputTokens += tokens(m.outputTokens);
      counts.cacheReadTokens += tokens(m.cacheReadInputTokens);
      counts.cacheCreationTokens += tokens(m.cacheCreationInputTokens);
    }
  } else {
    const usage = asRecord(event.usage) ?? {};
    counts.inputTokens = tokens(usage.input_tokens);
    counts.outputTokens = tokens(usage.output_tokens);
    counts.cacheReadTokens = tokens(usage.cache_read_input_tokens);
    counts.cacheCreationTokens = tokens(usage.cache_creation_input_tokens);
  }
  const turns = numberOrNull(event.num_turns);
  const duration = numberOrNull(event.duration_ms);
  return {
    ...counts,
    costUsd: numberOrNull(event.total_cost_usd),
    numTurns: turns === null ? null : Math.round(turns),
    durationMs: duration === null ? null : Math.round(duration),
  };
}

/** The usage in the last `result` event of a log slice, or null when the slice holds none. */
export function usageFromLog(text: string): SessionUsage | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const { rest } = splitLogLine(lines[i]!);
    if (!rest.startsWith("{")) continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(rest));
    } catch {
      continue;
    }
    if (event?.type === "result") return usageFromResult(event);
  }
  return null;
}

/**
 * Reads the end of a finished Session's log and stores what it used on its row. Called once from
 * `endSession`, without waiting: nothing about ending a Session depends on it. A Session with no
 * `result` event, because it was stopped, never started, or ran on Codex, keeps null usage.
 */
export async function recordSessionUsage(sessionId: string, opts: { attempts?: number; waitMs?: number } = {}): Promise<void> {
  if (runner.mode === "noop") return;
  const row = await db
    .select({ provider: schema.sessions.provider, status: schema.sessions.status })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!row || row.provider !== "claude") return;
  // A Session that exited on its own wrote the event just before it did. One that was cancelled or
  // timed out was killed before it could, so a single look is enough.
  const attempts = row.status === "succeeded" || row.status === "failed" ? (opts.attempts ?? READ_ATTEMPTS) : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(opts.waitMs ?? READ_WAIT_MS, undefined, { ref: false });
    // Offset 0 returns the whole log, or its last 256 KB when it is longer; the event is at the end.
    let slice;
    try {
      slice = await runner.logSlice(sessionId, 0);
    } catch (err) {
      // Usually the runner restarting alongside the app. The Session simply shows no usage.
      console.warn(`[usage] could not read the log of ${sessionId}: ${(err as Error).message}`);
      return;
    }
    if (!slice.exists) return;
    const usage = usageFromLog(slice.text);
    if (!usage) continue;
    await db.update(schema.sessions).set(usage).where(eq(schema.sessions.id, sessionId));
    return;
  }
}

/** A Session row's usage, or null when none was recorded. */
export function usageOf(row: typeof schema.sessions.$inferSelect): SessionUsage | null {
  if (row.inputTokens === null && row.outputTokens === null && row.costUsd === null) return null;
  return {
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    costUsd: row.costUsd,
    numTurns: row.numTurns,
    durationMs: row.durationMs,
  };
}

/** Per-Board totals over the Sessions created in the last `days`, costliest Board first. */
export async function usageTotals(days = 30, now = new Date()): Promise<UsageTotalsView> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const s = schema.sessions;
  const costUsd = sql<number>`coalesce(sum(${s.costUsd}), 0)`;
  const rows = await db
    .select({
      boardId: s.boardId,
      sessions: sql<number>`count(*)`,
      measured: sql<number>`count(${s.inputTokens})`,
      inputTokens: sql<number>`coalesce(sum(${s.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${s.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${s.cacheReadTokens}), 0)`,
      cacheCreationTokens: sql<number>`coalesce(sum(${s.cacheCreationTokens}), 0)`,
      costUsd,
    })
    .from(s)
    .where(gte(s.createdAt, since))
    .groupBy(s.boardId)
    .orderBy(desc(costUsd));
  const boards: BoardUsageTotal[] = rows.map((r) => ({
    boardId: r.boardId,
    sessions: Number(r.sessions),
    measured: Number(r.measured),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheCreationTokens: Number(r.cacheCreationTokens),
    costUsd: Number(r.costUsd),
  }));
  return { days, since, boards };
}
