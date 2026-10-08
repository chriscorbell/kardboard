import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Card, CardType, Column, Priority } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";

async function hydrate(rows: (typeof schema.cards.$inferSelect)[]): Promise<Card[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({ cardId: schema.comments.cardId, n: sql<number>`count(*)` })
    .from(schema.comments)
    .where(inArray(schema.comments.cardId, ids))
    .groupBy(schema.comments.cardId);
  const countMap = new Map(counts.map((c) => [c.cardId, Number(c.n)]));
  const awaiting = await awaitingReply(rows.filter((r) => r.column === "blocked").map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    boardId: r.boardId,
    title: r.title,
    description: r.description,
    type: r.type,
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
    commentCount: countMap.get(r.id) ?? 0,
    awaitingReply: awaiting.has(r.id),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// Of these Blocked Cards, the ones whose last word is the Agent's: its question, still unanswered.
// kardboard's own system Comments are notices rather than a reply, so they are passed over. Two
// Comments written in the same millisecond both count as last, and a person's among them is a reply.
async function awaitingReply(blockedIds: string[]): Promise<Set<string>> {
  if (blockedIds.length === 0) return new Set();
  const last = await db
    .select({ cardId: schema.comments.cardId, authorKind: schema.comments.authorKind })
    .from(schema.comments)
    .where(
      and(
        inArray(schema.comments.cardId, blockedIds),
        ne(schema.comments.authorKind, "system"),
        sql`not exists (select 1 from comments later where later.card_id = ${schema.comments.cardId} and later.author_kind != 'system' and later.created_at > ${schema.comments.createdAt})`,
      ),
    );
  const out = new Set(last.filter((c) => c.authorKind === "agent").map((c) => c.cardId));
  for (const c of last) if (c.authorKind === "user") out.delete(c.cardId);
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

/** Every Card not in Done, on every Board: what the Overview is made of. */
export async function listOpenCards(): Promise<Card[]> {
  const rows = await db.select().from(schema.cards).where(ne(schema.cards.column, "done")).orderBy(asc(schema.cards.position), asc(schema.cards.createdAt));
  return hydrate(rows);
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

/** A position before every Card in the Column, or after every one. The Board reads a Column top down. */
export async function edgePosition(boardId: string, column: Column, edge: "top" | "bottom"): Promise<number> {
  if (edge === "bottom") return nextPosition(boardId, column);
  const first = await db
    .select({ position: schema.cards.position })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), eq(schema.cards.column, column)))
    .orderBy(asc(schema.cards.position))
    .limit(1)
    .get();
  return (first?.position ?? 1000) - 1000;
}

export class ConflictError extends Error {
  status = 409;
}

export async function createCard(input: {
  boardId: string;
  title: string;
  description: string;
  type?: CardType;
  priority: Priority;
  column: Column;
  actor: Actor;
  parentCardId?: string | null;
  // Where in its Column the Card goes. A new Card joins the bottom unless its creator puts it first.
  at?: "top" | "bottom";
}): Promise<Card> {
  const id = newId();
  await db.insert(schema.cards).values({
    id,
    boardId: input.boardId,
    title: input.title,
    description: input.description,
    type: input.type ?? "task",
    priority: input.priority,
    column: input.column,
    position: await edgePosition(input.boardId, input.column, input.at ?? "bottom"),
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
  return card;
}

export async function updateCard(
  id: string,
  input: {
    title?: string;
    description?: string;
    type?: CardType;
    priority?: Priority;
    revision: number;
    actor: Actor;
  },
): Promise<Card> {
  const current = await getCard(id);
  if (!current) throw new Error("card not found");
  if (current.revision !== input.revision) throw new ConflictError("card changed since you loaded it");
  const changed: Record<string, unknown> = {};
  if (input.title !== undefined && input.title !== current.title) changed.title = input.title;
  if (input.description !== undefined && input.description !== current.description)
    changed.description = input.description;
  if (input.type !== undefined && input.type !== current.type) changed.type = input.type;
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
  // What each changed field said before, so no edit, a person's or the Agent's, loses an author's words.
  const previous = Object.fromEntries(Object.keys(changed).map((field) => [field, current[field as "title" | "description" | "type" | "priority"]]));
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor: input.actor,
    type: "card.edited",
    payload: { fields: Object.keys(changed), previous },
  });
  publish(card.boardId, { type: "card.upserted", card });
  return card;
}

/**
 * `merged` is for a move to Done by the agent that merged the Card's pull request. It records the
 * merge, so the Card closes as implemented rather than merely closed.
 */
export async function moveCard(
  id: string,
  input: { column: Column; position: number; revision: number; actor: Actor; merged?: boolean },
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
      ...(enteringDone ? { outcome: input.merged ? "implemented" : "closed" } : leavingDone ? { outcome: null } : {}),
    })
    .where(and(eq(schema.cards.id, id), eq(schema.cards.revision, input.revision)))
    .returning({ id: schema.cards.id });
  if (written.length === 0) throw new ConflictError("card changed since you loaded it");
  const card = (await getCard(id))!;
  if (columnChanged) {
    if (enteringDone && input.merged) {
      await recordEvent({ boardId: card.boardId, cardId: card.id, actor: input.actor, type: "card.merged", payload: { prNumber: current.prNumber, prUrl: current.prUrl } });
    }
    await recordEvent({
      boardId: card.boardId,
      cardId: card.id,
      actor: input.actor,
      type: "card.moved",
      payload: { from: current.column, to: input.column },
    });
  }
  publish(card.boardId, { type: "card.upserted", card });
  return card;
}

export async function setCardWorkState(
  id: string,
  patch: {
    branch?: string | null;
    prUrl?: string | null;
    prNumber?: number | null;
  },
): Promise<Card> {
  await db
    .update(schema.cards)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.cards.id, id));
  const card = (await getCard(id))!;
  publish(card.boardId, { type: "card.upserted", card });
  return card;
}
