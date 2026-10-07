import { and, eq, inArray, sql } from "drizzle-orm";
import type { BoardDeletionImpact } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { takeSnapshot, type SnapshotResult } from "./backup.js";
import { removeUnusedUploads } from "./comments.js";
import { recordEvent, type Actor } from "./events.js";
import { publish } from "./realtime.js";

// Refused before anything is removed: the message is for the Admin, `status` for the response.
export class BoardDeletionRefused extends Error {
  constructor(
    message: string,
    public status: 503,
  ) {
    super(message);
  }
}

const cardsOf = (boardId: string) => db.select({ id: schema.cards.id }).from(schema.cards).where(eq(schema.cards.boardId, boardId));
const commentsOf = (boardId: string) => db.select({ id: schema.comments.id }).from(schema.comments).where(inArray(schema.comments.cardId, cardsOf(boardId)));
async function count(query: Promise<{ n: number } | undefined>): Promise<number> {
  return Number((await query)?.n ?? 0);
}

export async function boardDeletionImpact(boardId: string): Promise<BoardDeletionImpact> {
  const n = sql<number>`count(*)`;
  return {
    cards: await count(db.select({ n }).from(schema.cards).where(eq(schema.cards.boardId, boardId)).get()),
    comments: await count(db.select({ n }).from(schema.comments).where(inArray(schema.comments.cardId, cardsOf(boardId))).get()),
    attachments: await count(db.select({ n }).from(schema.attachments).where(inArray(schema.attachments.commentId, commentsOf(boardId))).get()),
  };
}

/**
 * Removes a Board for good: its Cards and everything on them, its event log, its Members' access,
 * and each uploaded file nothing else points at. A snapshot is taken first and the delete is refused
 * without one, so a Board deleted by mistake can be restored from Backups; for the same reason the
 * off-disk copy of its attachments is left in place. Emails already sent stay on the record; one
 * still waiting that quotes a deleted Comment is not sent.
 *
 * `uploadsRemoved` settles once the files are gone: after the snapshot's copy off the disk, which
 * must not miss them.
 */
export async function deleteBoard(
  boardId: string,
  actor: Actor,
  snapshot: () => Promise<SnapshotResult> = () => takeSnapshot(),
): Promise<{ snapshot: string; uploadsRemoved: Promise<number> }> {
  const board = await db.select().from(schema.boards).where(eq(schema.boards.id, boardId)).get();
  if (!board) throw new Error("board not found");
  let taken: SnapshotResult;
  try {
    taken = await snapshot();
  } catch (err) {
    throw new BoardDeletionRefused(`No snapshot could be taken first, so nothing was deleted: ${err instanceof Error ? err.message : String(err)}`, 503);
  }

  // The deletes are one batch, which libsql runs as a single transaction, children before parents.
  const removed = await (async () => {
    const hashes = new Set((await db.select({ sha256: schema.attachments.sha256 }).from(schema.attachments).where(inArray(schema.attachments.commentId, commentsOf(boardId)))).map((a) => a.sha256));
    const cards = await count(db.select({ n: sql<number>`count(*)` }).from(schema.cards).where(eq(schema.cards.boardId, boardId)).get());
    await db.batch([
      db.delete(schema.notifications).where(eq(schema.notifications.boardId, boardId)),
      db.delete(schema.mentions).where(inArray(schema.mentions.commentId, commentsOf(boardId))),
      db.delete(schema.attachments).where(inArray(schema.attachments.commentId, commentsOf(boardId))),
      db.delete(schema.commentRevisions).where(inArray(schema.commentRevisions.commentId, commentsOf(boardId))),
      db.delete(schema.outboundEmails).where(and(inArray(schema.outboundEmails.commentId, commentsOf(boardId)), eq(schema.outboundEmails.status, "pending"))),
      db.delete(schema.comments).where(inArray(schema.comments.cardId, cardsOf(boardId))),
      db.delete(schema.events).where(eq(schema.events.boardId, boardId)),
      db.delete(schema.cards).where(eq(schema.cards.boardId, boardId)),
      db.delete(schema.boardMembers).where(eq(schema.boardMembers.boardId, boardId)),
      db.delete(schema.accessTokens).where(eq(schema.accessTokens.boardId, boardId)),
      db.delete(schema.boards).where(eq(schema.boards.id, boardId)),
    ]);
    return { hashes, cards };
  })();

  publish(boardId, { type: "board.deleted", boardId });
  // The one row left under the Board's id: who deleted it, and which snapshot still holds it.
  await recordEvent({ boardId, actor, type: "board.deleted", payload: { name: board.name, slug: board.slug, cards: removed.cards, snapshot: taken.snapshot.name } });
  console.log(`[board] deleted ${board.slug} (${removed.cards} card(s)); ${taken.snapshot.name} holds it`);
  const uploadsRemoved = taken.copy
    .catch(() => null)
    .then(() => removeUnusedUploads(removed.hashes, { offDiskCopy: false }))
    .catch((err: unknown) => {
      console.error(`[board] could not remove the attachments of ${board.slug}`, err);
      return 0;
    });
  return { snapshot: taken.snapshot.name, uploadsRemoved };
}
