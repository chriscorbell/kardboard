import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { ACTIVE_SESSION_STATUSES, ADMIN_SESSIONS_PAGE, SESSION_KINDS, SESSION_STATUSES, type AdminSessionSummary, type AdminSessionsPage, type SessionKind, type SessionStatus } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { summary } from "./orchestrator.js";
import { usageOf } from "./usage.js";

// The Admin's Sessions tab: every Session on every Board, newest first, a page at a time. Filters
// narrow by Board, status, and kind; `active` stands for the three statuses that still hold a Claim.

export interface SessionFilters {
  boardId?: string;
  status?: SessionStatus | "active";
  kind?: SessionKind;
  /** The previous page's `nextCursor`: where the last Session on it sat in the order. */
  before?: string;
  limit?: number;
}

// The cursor is the last Session's place in the order, its creation time and id, rather than its id
// alone: a Session removed between two pages would otherwise leave nothing to find and restart the
// list from the top.
const cursorOf = (row: { createdAt: string; id: string }) => `${row.createdAt}|${row.id}`;

function parseCursor(cursor: string): { createdAt: string; id: string } | null {
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0 || bar === cursor.length - 1) return null;
  return { createdAt: cursor.slice(0, bar), id: cursor.slice(bar + 1) };
}

/** Reads filters from query parameters, dropping any value that is not one the list knows. */
export function sessionFilters(query: Record<string, string | undefined>): SessionFilters {
  const status = query.status;
  const kind = query.kind;
  return {
    boardId: query.board || undefined,
    status: status === "active" || (SESSION_STATUSES as readonly string[]).includes(status ?? "") ? (status as SessionFilters["status"]) : undefined,
    kind: (SESSION_KINDS as readonly string[]).includes(kind ?? "") ? (kind as SessionKind) : undefined,
    before: query.before || undefined,
  };
}

function toAdmin(row: typeof schema.sessions.$inferSelect, cardTitle: string | null): AdminSessionSummary {
  return { ...summary(row), boardId: row.boardId, cardTitle, usage: usageOf(row) };
}

export async function listAdminSessions(filters: SessionFilters = {}): Promise<AdminSessionsPage> {
  const s = schema.sessions;
  const limit = filters.limit ?? ADMIN_SESSIONS_PAGE;
  const where: SQL[] = [];
  if (filters.boardId) where.push(eq(s.boardId, filters.boardId));
  if (filters.status === "active") where.push(inArray(s.status, [...ACTIVE_SESSION_STATUSES]));
  else if (filters.status) where.push(eq(s.status, filters.status));
  if (filters.kind) where.push(eq(s.kind, filters.kind));
  if (filters.before) {
    // Newest first by creation, and by id within the same instant, so the cursor is exact even when
    // two Sessions were created in the same millisecond. A cursor that is not one answers nothing
    // rather than the first page again, which a "Load more" would append as duplicates.
    const cursor = parseCursor(filters.before);
    if (!cursor) return { sessions: [], nextCursor: null };
    where.push(or(lt(s.createdAt, cursor.createdAt), and(eq(s.createdAt, cursor.createdAt), lt(s.id, cursor.id)))!);
  }
  const rows = await db
    .select({ session: s, cardTitle: schema.cards.title })
    .from(s)
    .leftJoin(schema.cards, eq(schema.cards.id, s.cardId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(s.createdAt), desc(s.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => toAdmin(r.session, r.cardTitle));
  return { sessions: page, nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null };
}

export async function getAdminSession(id: string): Promise<AdminSessionSummary | null> {
  const row = await db
    .select({ session: schema.sessions, cardTitle: schema.cards.title })
    .from(schema.sessions)
    .leftJoin(schema.cards, eq(schema.cards.id, schema.sessions.cardId))
    .where(eq(schema.sessions.id, id))
    .get();
  return row ? toAdmin(row.session, row.cardTitle) : null;
}
