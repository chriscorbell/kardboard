import { and, asc, eq } from "drizzle-orm";
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

/**
 * Called when a Card reaches Done. If it was the last child its parent was waiting on, the parent
 * leaves Blocked and receives a `children_done` Trigger carrying what each child came to. Nobody
 * has to touch anything for this to happen, which is the whole point.
 */
export async function wakeParentIfSettled(child: { id: string; parentCardId: string | null }): Promise<void> {
  if (!child.parentCardId) return;
  const parentRow = await db.select().from(schema.cards).where(eq(schema.cards.id, child.parentCardId)).get();
  // A parent that is itself closed has nothing left to resume.
  if (!parentRow || parentRow.column === "done") return;
  const siblings = await db.select({ column: schema.cards.column }).from(schema.cards).where(eq(schema.cards.parentCardId, parentRow.id));
  if (!allChildrenDone(siblings)) return;

  const children = await childSummaries(parentRow.id);
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
