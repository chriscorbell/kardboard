import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Card, CardWaiting, Column, Priority, SessionSummary } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { activeCount, closeCardWork, dispatchPlanned, enqueueTrigger, latestEndedSessions } from "./orchestrator.js";
import { getAgentProfile, getSettings } from "./settings.js";
import { waitingState } from "./waiting.js";
import { notifyCardMoved } from "./notifications.js";
import { outcomeOnDone, startsItsOwnSession, wakeParentIfSettled } from "./children.js";

export function toSessionSummary(row: typeof schema.sessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    fallbackFrom: row.fallbackFrom,
    intent: row.intent,
    branch: row.branch,
    cardId: row.cardId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcomeSummary: row.outcomeSummary,
    createdAt: row.createdAt,
  };
}

async function hydrate(rows: (typeof schema.cards.$inferSelect)[]): Promise<Card[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({ cardId: schema.comments.cardId, n: sql<number>`count(*)` })
    .from(schema.comments)
    .where(inArray(schema.comments.cardId, ids))
    .groupBy(schema.comments.cardId);
  const countMap = new Map(counts.map((c) => [c.cardId, Number(c.n)]));
  const active = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        inArray(schema.sessions.cardId, ids),
        inArray(schema.sessions.status, ["queued", "starting", "running"]),
      ),
    );
  const activeMap = new Map(active.map((s) => [s.cardId!, toSessionSummary(s)]));
  const lastMap = await latestEndedSessions(ids);
  const waitingMap = await waitingFor(rows, activeMap, lastMap);
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardId,
    title: r.title,
    description: r.description,
    priority: r.priority,
    column: r.column,
    position: r.position,
    creatorKind: r.creatorKind,
    creatorId: r.creatorId,
    parentCardId: r.parentCardId,
    outcome: r.outcome,
    revision: r.revision,
    branch: r.branch,
    prUrl: r.prUrl,
    prNumber: r.prNumber,
    prHeadSha: r.prHeadSha,
    previewUrl: r.previewUrl,
    commentCount: countMap.get(r.id) ?? 0,
    activeSession: activeMap.get(r.id) ?? null,
    lastSession: lastMap.get(r.id) ?? null,
    waiting: waitingMap.get(r.id) ?? null,
    pendingRerun: r.pendingRerun,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * What each of these Cards is waiting for, for those with Triggers pending and no Session. The caps
 * and pause switches are read only when some Card is waiting, which on most reads none is.
 */
async function waitingFor(
  rows: (typeof schema.cards.$inferSelect)[],
  activeMap: Map<string, SessionSummary>,
  lastMap: Map<string, SessionSummary>,
): Promise<Map<string, CardWaiting>> {
  const out = new Map<string, CardWaiting>();
  const idle = rows.filter((r) => !activeMap.has(r.id)).map((r) => r.id);
  if (idle.length === 0) return out;
  const pending = await db
    .select({ cardId: schema.triggers.cardId, oldest: sql<string>`min(${schema.triggers.createdAt})` })
    .from(schema.triggers)
    .where(and(inArray(schema.triggers.cardId, idle), eq(schema.triggers.status, "pending")))
    .groupBy(schema.triggers.cardId);
  if (pending.length === 0) return out;
  const oldest = new Map(pending.map((p) => [p.cardId, p.oldest]));
  const boardIds = [...new Set(rows.filter((r) => oldest.has(r.id)).map((r) => r.boardId))];
  const boards = await db.select().from(schema.boards).where(inArray(schema.boards.id, boardIds));
  const settings = await getSettings();
  const globalFull = (await activeCount()) >= settings.globalMaxConcurrentSessions;
  const full = new Map<string, boolean>();
  for (const b of boards) full.set(b.id, globalFull || (await activeCount(b.id)) >= b.maxConcurrentSessions);
  const paused = new Map(boards.map((b) => [b.id, b.paused]));
  for (const r of rows) {
    const state = waitingState({
      oldestPendingAt: oldest.get(r.id) ?? null,
      active: activeMap.has(r.id),
      paused: paused.get(r.boardId) ?? false,
      slotsFull: full.get(r.boardId) ?? false,
      dispatchPlanned: dispatchPlanned(r.id),
      lastSession: lastMap.get(r.id) ?? null,
    });
    if (state) out.set(r.id, state);
  }
  return out;
}

export async function listCards(boardId: string): Promise<Card[]> {
  const rows = await db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.boardId, boardId))
    .orderBy(asc(schema.cards.position), asc(schema.cards.createdAt));
  return hydrate(rows);
}

export async function getCard(id: string): Promise<Card | null> {
  const row = await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get();
  if (!row) return null;
  return (await hydrate([row]))[0]!;
}

export async function listChildren(cardId: string): Promise<Card[]> {
  const rows = await db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.parentCardId, cardId))
    .orderBy(asc(schema.cards.createdAt));
  return hydrate(rows);
}

async function nextPosition(boardId: string, column: Column): Promise<number> {
  const last = await db
    .select({ position: schema.cards.position })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), eq(schema.cards.column, column)))
    .orderBy(desc(schema.cards.position))
    .limit(1)
    .get();
  return (last?.position ?? 0) + 1000;
}

export class ConflictError extends Error {
  status = 409;
}

export async function createCard(input: {
  boardId: string;
  title: string;
  description: string;
  priority: Priority;
  column: Column;
  actor: Actor;
  parentCardId?: string | null;
  silent?: boolean;
}): Promise<Card> {
  const id = newId();
  await db.insert(schema.cards).values({
    id,
    boardId: input.boardId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    column: input.column,
    position: await nextPosition(input.boardId, input.column),
    creatorKind: input.actor.kind,
    creatorId: input.actor.id,
    parentCardId: input.parentCardId ?? null,
  });
  const card = (await getCard(id))!;
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor: input.actor,
    type: "card.created",
    payload: { column: card.column },
  });
  publish(card.boardId, { type: "card.upserted", card });
  if (input.actor.kind === "user" && !input.silent) {
    await enqueueTrigger({ card, kind: "card_created", actorUserId: input.actor.id, payload: {} });
  } else if (startsItsOwnSession(card)) {
    // A Session split a request into this piece, so this piece starts its own Session: no person
    // asked for it Card by Card, and nobody should have to touch it for the work to begin.
    await enqueueTrigger({ card, kind: "child_card_created", actorUserId: null, payload: { parentCardId: card.parentCardId } });
  }
  return card;
}

export async function updateCard(
  id: string,
  input: {
    title?: string;
    description?: string;
    priority?: Priority;
    revision: number;
    actor: Actor;
    silent?: boolean;
  },
): Promise<Card> {
  const current = await getCard(id);
  if (!current) throw new Error("card not found");
  if (current.revision !== input.revision) throw new ConflictError("card changed since you loaded it");
  const changed: Record<string, unknown> = {};
  if (input.title !== undefined && input.title !== current.title) changed.title = input.title;
  if (input.description !== undefined && input.description !== current.description)
    changed.description = input.description;
  if (input.priority !== undefined && input.priority !== current.priority) changed.priority = input.priority;
  if (Object.keys(changed).length === 0) return current;
  // The revision is checked by the statement that writes, not only by the read above, so two edits
  // made from the same revision cannot both land.
  const written = await db
    .update(schema.cards)
    .set({ ...changed, revision: current.revision + 1, updatedAt: new Date().toISOString() })
    .where(and(eq(schema.cards.id, id), eq(schema.cards.revision, input.revision)))
    .returning({ id: schema.cards.id });
  if (written.length === 0) throw new ConflictError("card changed since you loaded it");
  const card = (await getCard(id))!;
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor: input.actor,
    type: "card.edited",
    payload: { fields: Object.keys(changed) },
  });
  publish(card.boardId, { type: "card.upserted", card });
  // Priority alone is a signal to the next Session, not a reason to start one.
  const substantive = "title" in changed || "description" in changed;
  if (input.actor.kind === "user" && substantive && !input.silent) {
    await enqueueTrigger({
      card,
      kind: "card_edited",
      actorUserId: input.actor.id,
      payload: { fields: Object.keys(changed) },
    });
  }
  return card;
}

export async function moveCard(
  id: string,
  input: { column: Column; position: number; revision: number; actor: Actor; silent?: boolean },
): Promise<Card> {
  const current = await getCard(id);
  if (!current) throw new Error("card not found");
  if (current.revision !== input.revision) throw new ConflictError("card changed since you loaded it");
  const columnChanged = current.column !== input.column;
  const enteringDone = columnChanged && input.column === "done";
  const leavingDone = columnChanged && current.column === "done";
  // As in updateCard: of two moves made from the same revision, only the first is written.
  const written = await db
    .update(schema.cards)
    .set({
      column: input.column,
      position: input.position,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      // What the Card came to is recorded as it closes, and forgotten when it is reopened.
      ...(enteringDone ? { outcome: await outcomeOnDone(id) } : leavingDone ? { outcome: null } : {}),
    })
    .where(and(eq(schema.cards.id, id), eq(schema.cards.revision, input.revision)))
    .returning({ id: schema.cards.id });
  if (written.length === 0) throw new ConflictError("card changed since you loaded it");
  let card = (await getCard(id))!;
  if (columnChanged) {
    await recordEvent({
      boardId: card.boardId,
      cardId: card.id,
      actor: input.actor,
      type: "card.moved",
      payload: { from: current.column, to: input.column },
    });
    // Leaving Review for anything but Done voids a standing Approval; Done is where a consumed Approval ends up.
    if (current.column === "review" && input.column !== "done") {
      await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString() }).where(and(eq(schema.approvals.cardId, id), isNull(schema.approvals.invalidatedAt)));
    }
    // A human move to Done closes the card: the active Session is cancelled and nothing re-runs.
    if (input.column === "done" && input.actor.kind === "user") {
      await closeCardWork(id, input.actor);
      card = (await getCard(id))!;
    }
  }
  publish(card.boardId, { type: "card.upserted", card });
  // The last child of a split request reaching Done is what wakes its parent.
  if (enteringDone) await wakeParentIfSettled(card).catch((err) => console.error("[children] could not wake the parent", err));
  if (columnChanged) void notifyCardMoved(card, current.column, input.actor).catch((err) => console.error("[notify] card moved", err));
  if (columnChanged && input.actor.kind === "user" && input.column !== "done" && !input.silent) {
    await enqueueTrigger({
      card,
      kind: "card_moved",
      actorUserId: input.actor.id,
      payload: { from: current.column, to: input.column },
    });
  }
  return card;
}

export class RetryRefused extends Error {
  status = 409 as const;
}

/**
 * Try again: a `retry_requested` Trigger that starts a Session at once rather than after the
 * batching window, since pressing the button is the whole request. Refused while a Session holds
 * the Card, which would make it a pending re-run nobody asked for, and in Done, where a Comment is
 * how a closed Card is reopened. The Trigger carries the Session it follows, so the next one can
 * read what went wrong.
 */
export async function retryCard(id: string, actor: Actor): Promise<Card> {
  const card = await getCard(id);
  if (!card) throw new Error("card not found");
  const agent = await getAgentProfile();
  if (card.activeSession) throw new RetryRefused(`${agent.name} is already working on this card.`);
  if (card.column === "done") throw new RetryRefused("This card is done. Add a comment to reopen it.");
  const last = card.lastSession;
  const payload = last ? { sessionId: last.id, status: last.status, outcomeSummary: last.outcomeSummary } : {};
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor, type: "card.retry_requested", payload });
  await enqueueTrigger({ card, kind: "retry_requested", actorUserId: actor.id, payload, promptly: true });
  return (await getCard(id))!;
}

export async function setCardWorkState(
  id: string,
  patch: { branch?: string | null; prUrl?: string | null; prNumber?: number | null; prHeadSha?: string | null; previewUrl?: string | null },
): Promise<Card> {
  await db
    .update(schema.cards)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.cards.id, id));
  const card = (await getCard(id))!;
  publish(card.boardId, { type: "card.upserted", card });
  return card;
}
