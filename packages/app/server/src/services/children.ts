import { and, asc, desc, eq } from "drizzle-orm";
import type { ActorKind, CardOutcome, Column, Priority } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { recordEvent, SYSTEM_ACTOR } from "./events.js";

// Splitting a large request is the one kind of work no person asks for Card by Card: a Session
// creates the child Cards itself, and until now nothing started a Session on them and nothing woke
// the parent when they finished. The two rules that fix that are here, and both are deliberately
// narrow, so that an Agent Card still does not become a way for the Agent to start itself.
//
//   Dispatch   An Agent-created Card starts its own Session only when it is a child of another
//              Card and lands in Ready. An Agent Card with no parent is a note for a person — an
//              Admin step, a follow-up someone should triage — and Ready is where they find it.
//
//   Waking     The parent is woken once, when the last of its children has reached Done, and is
//              told which of them were implemented and which were closed without an
//              implementation. Until then it waits in Blocked and nothing re-reads it.

export interface ChildSummary {
  id: string;
  title: string;
  outcome: CardOutcome;
}

/** Whether creating this Card should also start a Session on it. */
export function startsItsOwnSession(card: { creatorKind: ActorKind; parentCardId: string | null; column: Column }): boolean {
  return card.creatorKind === "agent" && card.parentCardId !== null && card.column === "ready";
}

/**
 * The most pieces one request is split into. Each child starts a Session of its own, so a split is
 * also a burst of Sessions on the Admin's subscriptions, and a request that needs more pieces than
 * this needs a person to look at it first.
 */
export const MAX_CHILDREN = 8;

/**
 * Why this Card may not be given another child, or null when it may. A split is one level deep: a
 * child that splits again would wake a parent that is itself waiting on a parent, and nothing on
 * the Board shows a person that tree.
 */
export function childRefusal(parent: { id: string; parentCardId: string | null }, existingChildren: number): string | null {
  if (parent.parentCardId) {
    return `card ${parent.id} is itself a piece of card ${parent.parentCardId}, and a piece is not split again. Do this piece's work in this card, or, if it is still too large, say so in a comment on the parent.`;
  }
  if (existingChildren >= MAX_CHILDREN) {
    return `card ${parent.id} already has ${existingChildren} child cards, the most one request is split into. Fold what is left into those pieces or into this card.`;
  }
  return null;
}

export async function countChildren(parentCardId: string): Promise<number> {
  const rows = await db.select({ id: schema.cards.id }).from(schema.cards).where(eq(schema.cards.parentCardId, parentCardId));
  return rows.length;
}

/** A parent waits for every child, whatever each of them turned out to be. */
export function allChildrenDone(children: { column: Column }[]): boolean {
  return children.length > 0 && children.every((c) => c.column === "done");
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };

export interface DispatchCandidate {
  priority: Priority;
  /** The Card's own position in its Column: the Board's order, as a person arranged it. */
  position: number;
  createdAt: string;
}

/**
 * Which waiting Card goes next when there are more of them than there are Session slots — a split
 * request creates its children in one burst, so this is the ordinary case and not a rare one.
 * Priority first, then the Board's own ordering, then age, so nothing waits behind a newer Card of
 * the same standing.
 */
export function byDispatchOrder(a: DispatchCandidate, b: DispatchCandidate): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  if (a.position !== b.position) return a.position - b.position;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * What a Card that has just reached Done turned out to be. kardboard performs every merge itself
 * after an Approval, so the recorded merge is the evidence that the work was implemented; a Card
 * that reached Done any other way was closed — a duplicate, or work that was not needed.
 */
export async function outcomeOnDone(cardId: string): Promise<CardOutcome> {
  const merged = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(eq(schema.events.cardId, cardId), eq(schema.events.type, "card.merged")))
    .get();
  return merged ? "implemented" : "closed";
}

export async function childSummaries(parentCardId: string): Promise<ChildSummary[]> {
  const rows = await db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.parentCardId, parentCardId))
    .orderBy(asc(schema.cards.createdAt));
  // A Card that reached Done before this column existed still has its merge on record.
  return Promise.all(rows.map(async (r) => ({ id: r.id, title: r.title, outcome: r.outcome ?? (await outcomeOnDone(r.id)) })));
}

/** Whether two settlements are the same: the same children, each come to the same outcome. */
export function sameSettlement(a: Pick<ChildSummary, "id" | "outcome">[], b: Pick<ChildSummary, "id" | "outcome">[]): boolean {
  const key = (children: Pick<ChildSummary, "id" | "outcome">[]) =>
    children
      .map((c) => `${c.id}:${c.outcome}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

const waking = new Map<string, Promise<unknown>>();

/**
 * Called when a Card reaches Done. If it was the last child its parent was waiting on, the parent
 * leaves Blocked and receives a `children_done` Trigger carrying what each child came to. Nobody
 * has to touch anything for this to happen, which is the whole point.
 *
 * Once per settlement: a child that reaches Done again with nothing changed — reopened and closed
 * the same way, or put back in Done by a merge being completed a second time — does not wake the
 * parent again with news it already has. Two children finishing together are woken for one at a
 * time, so they cannot both find the other done and both wake it.
 */
export function wakeParentIfSettled(child: { id: string; parentCardId: string | null }): Promise<void> {
  const parentId = child.parentCardId;
  if (!parentId) return Promise.resolve();
  const run = (waking.get(parentId) ?? Promise.resolve()).then(() => wakeUnderLock(parentId));
  const tail = run.catch(() => undefined);
  waking.set(parentId, tail);
  void tail.then(() => {
    if (waking.get(parentId) === tail) waking.delete(parentId);
  });
  return run;
}

async function wakeUnderLock(parentId: string): Promise<void> {
  const parentRow = await db.select().from(schema.cards).where(eq(schema.cards.id, parentId)).get();
  // A parent that is itself closed has nothing left to resume.
  if (!parentRow || parentRow.column === "done") return;
  const siblings = await db.select({ column: schema.cards.column }).from(schema.cards).where(eq(schema.cards.parentCardId, parentRow.id));
  if (!allChildrenDone(siblings)) return;

  const children = await childSummaries(parentRow.id);
  const last = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.cardId, parentRow.id), eq(schema.events.type, "card.children_done")))
    .orderBy(desc(schema.events.createdAt))
    .limit(1)
    .get();
  if (last && Array.isArray(last.payload.children) && sameSettlement(last.payload.children as ChildSummary[], children)) return;
  // Lazy imports: cards.ts and orchestrator.ts both reach back into this module.
  const { getCard, moveCard } = await import("./cards.js");
  const { enqueueTrigger } = await import("./orchestrator.js");
  let parent = (await getCard(parentRow.id))!;
  // It sat in Blocked for its children; with none left to wait for it is Ready again.
  if (parent.column === "blocked") {
    parent = await moveCard(parent.id, { column: "ready", position: parent.position, revision: parent.revision, actor: SYSTEM_ACTOR });
  }
  await recordEvent({ boardId: parent.boardId, cardId: parent.id, actor: SYSTEM_ACTOR, type: "card.children_done", payload: { children } });
  await enqueueTrigger({ card: parent, kind: "children_done", actorUserId: null, payload: { children } });
}
