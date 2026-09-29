import { eq, inArray } from "drizzle-orm";
import type { Card, User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { getCard } from "./cards.js";
import { underClaimLock } from "./orchestrator.js";
import { cardLockHeld } from "./approvals.js";
import { removePreviewForCard } from "./previews.js";
import { forgetCommentTraces } from "./notifications.js";
import { removeUnusedUploads } from "./comments.js";
import { wakeParentIfSettled } from "./children.js";
import { getAgentProfile } from "./settings.js";

export class CardDeletionRefused extends Error {
  constructor(
    message: string,
    public status: 409 = 409,
  ) {
    super(message);
  }
}

/**
 * Who may delete a Card, as with Comments: the Admin any Card, a Member one they created. A Card the
 * Agent created is the Admin's to delete, and the Agent's own through an Access token.
 */
export function mayDeleteCard(user: Pick<User, "id" | "role">, card: Pick<Card, "creatorKind" | "creatorId">): boolean {
  return user.role === "admin" || (card.creatorKind === "user" && card.creatorId === user.id);
}

/**
 * Deletes a Card for good, with its Comments, their Attachments and revisions, its Approvals,
 * notifications, Preview, and waiting Triggers. Its events go too, since they carry what it said;
 * the log keeps one `card.deleted` event that records who deleted it, not what it said. Its
 * Sessions stay, for their usage. Children lose their parent rather than their existence, and a
 * parent waiting on this Card as its last open child wakes. Refused while a Session holds the Card
 * or a merge is in flight on it. The repository is not touched.
 */
export async function deleteCard(cardId: string, actor: Actor): Promise<void> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  await refusal(card);

  const comments = await db.select({ id: schema.comments.id, body: schema.comments.body }).from(schema.comments).where(eq(schema.comments.cardId, cardId));
  const commentIds = comments.map((c) => c.id);
  const revisions = commentIds.length ? await db.select({ commentId: schema.commentRevisions.commentId, body: schema.commentRevisions.body }).from(schema.commentRevisions).where(inArray(schema.commentRevisions.commentId, commentIds)) : [];
  const hashes = new Set(commentIds.length ? (await db.select({ sha256: schema.attachments.sha256 }).from(schema.attachments).where(inArray(schema.attachments.commentId, commentIds))).map((a) => a.sha256) : []);
  const children = await db.select({ id: schema.cards.id }).from(schema.cards).where(eq(schema.cards.parentCardId, cardId));

  // The slow parts first, outside the claim lock: the runner stops the Preview, and emails still
  // waiting to quote the Card's Comments are withdrawn.
  await removePreviewForCard(cardId);
  for (const c of comments) await forgetCommentTraces(c.id, cardId, [c.body, ...revisions.filter((r) => r.commentId === c.id).map((r) => r.body)]);

  // Under the lock dispatch takes, so a Session cannot claim the Card between the check and the delete.
  await underClaimLock(async () => {
    const now = await getCard(cardId);
    if (!now) return;
    await refusal(now);
    // The Card's own rows go with it by foreign key: Comments and what hangs off them, Approvals,
    // notifications, and the Preview. Triggers and events carry its id without one.
    await db.batch([
      db.delete(schema.triggers).where(eq(schema.triggers.cardId, cardId)),
      db.delete(schema.events).where(eq(schema.events.cardId, cardId)),
      db.update(schema.cards).set({ parentCardId: null }).where(eq(schema.cards.parentCardId, cardId)),
      db.delete(schema.cards).where(eq(schema.cards.id, cardId)),
    ]);
  });
  if (await getCard(cardId)) return;

  await recordEvent({ boardId: card.boardId, cardId, actor, type: "card.deleted", payload: { creatorKind: card.creatorKind, creatorId: card.creatorId } });
  await removeUnusedUploads(hashes, { offDiskCopy: true });
  publish(card.boardId, { type: "card.removed", cardId });
  for (const child of children) {
    const updated = await getCard(child.id);
    if (updated) publish(card.boardId, { type: "card.upserted", card: updated });
  }
  if (card.parentCardId) await wakeParentIfSettled({ id: cardId, parentCardId: card.parentCardId }).catch((err) => console.error("[children] could not wake the parent", err));
}

async function refusal(card: Card): Promise<void> {
  if (card.activeSession) {
    const agent = await getAgentProfile();
    throw new CardDeletionRefused(`${agent.name} is working on this card. Let the session finish, or cancel it, then delete the card.`);
  }
  if (cardLockHeld(card.id)) throw new CardDeletionRefused("This card is being merged right now. Try again in a moment.");
}
