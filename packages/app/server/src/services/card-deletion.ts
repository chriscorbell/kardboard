import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { getCard } from "./cards.js";
import { removeUnusedUploads } from "./comments.js";

/**
 * Deletes a Card for good, with its Comments and their Attachments and revisions. Its events go too, since they carry what it said; the log keeps one `card.deleted`
 * event that records who deleted it, not what it said. Children lose their parent rather than their
 * existence. The repository is not touched.
 */
export async function deleteCard(cardId: string, actor: Actor): Promise<void> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");

  const comments = await db.select({ id: schema.comments.id }).from(schema.comments).where(eq(schema.comments.cardId, cardId));
  const commentIds = comments.map((c) => c.id);
  const hashes = new Set(commentIds.length ? (await db.select({ sha256: schema.attachments.sha256 }).from(schema.attachments).where(inArray(schema.attachments.commentId, commentIds))).map((a) => a.sha256) : []);
  const children = await db.select({ id: schema.cards.id }).from(schema.cards).where(eq(schema.cards.parentCardId, cardId));

  // The Card's own rows go with it by foreign key: Comments and what hangs off them. Events carry its
  // id without one.
  await db.batch([
    db.delete(schema.events).where(eq(schema.events.cardId, cardId)),
    db.update(schema.cards).set({ parentCardId: null }).where(eq(schema.cards.parentCardId, cardId)),
    db.delete(schema.cards).where(eq(schema.cards.id, cardId)),
  ]);

  await recordEvent({ boardId: card.boardId, cardId, actor, type: "card.deleted", payload: { creatorKind: card.creatorKind, creatorId: card.creatorId } });
  await removeUnusedUploads(hashes, { offDiskCopy: true });
  publish(card.boardId, { type: "card.removed", cardId });
  for (const child of children) {
    const updated = await getCard(child.id);
    if (updated) publish(card.boardId, { type: "card.upserted", card: updated });
  }
}
