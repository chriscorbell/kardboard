import { asc, eq, inArray } from "drizzle-orm";
import { extractMentionHandles, type Attachment, type Comment } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { enqueueTrigger } from "./orchestrator.js";
import { getCard } from "./cards.js";
import { findUsersByHandles } from "./users.js";
import { notifyMentions } from "./notifications.js";

function toAttachment(row: typeof schema.attachments.$inferSelect): Attachment {
  return {
    id: row.id,
    commentId: row.commentId,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    createdAt: row.createdAt,
  };
}

async function hydrate(rows: (typeof schema.comments.$inferSelect)[]): Promise<Comment[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.commentId, ids));
  const mens = await db.select().from(schema.mentions).where(inArray(schema.mentions.commentId, ids));
  return rows.map((r) => ({
    id: r.id,
    cardId: r.cardId,
    authorKind: r.authorKind,
    authorId: r.authorId,
    sessionId: r.sessionId,
    body: r.body,
    editedAt: r.editedAt,
    createdAt: r.createdAt,
    attachments: atts.filter((a) => a.commentId === r.id).map(toAttachment),
    mentions: mens.filter((m) => m.commentId === r.id).map((m) => m.userId),
  }));
}

export async function listComments(cardId: string): Promise<Comment[]> {
  const rows = await db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.cardId, cardId))
    .orderBy(asc(schema.comments.createdAt));
  return hydrate(rows);
}

export async function getComment(id: string): Promise<Comment | null> {
  const row = await db.select().from(schema.comments).where(eq(schema.comments.id, id)).get();
  return row ? (await hydrate([row]))[0]! : null;
}

async function syncMentions(comment: Comment, actor: Actor): Promise<string[]> {
  const handles = extractMentionHandles(comment.body);
  const users = await findUsersByHandles(handles);
  const existing = new Set(comment.mentions);
  const fresh = users.filter((u) => !existing.has(u.id) && u.id !== actor.id);
  if (fresh.length > 0) {
    await db
      .insert(schema.mentions)
      .values(fresh.map((u) => ({ commentId: comment.id, userId: u.id })))
      .onConflictDoNothing();
  }
  return fresh.map((u) => u.id);
}

export async function createComment(input: {
  cardId: string;
  body: string;
  actor: Actor;
  sessionId?: string | null;
  silent?: boolean;
}): Promise<Comment> {
  const card = await getCard(input.cardId);
  if (!card) throw new Error("card not found");
  const id = newId();
  await db.insert(schema.comments).values({
    id,
    cardId: input.cardId,
    authorKind: input.actor.kind,
    authorId: input.actor.id,
    sessionId: input.sessionId ?? null,
    body: input.body,
  });
  let comment = (await getComment(id))!;
  const newlyMentioned = await syncMentions(comment, input.actor);
  comment = (await getComment(id))!;
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor: input.actor,
    type: "comment.posted",
    payload: { commentId: id },
  });
  publish(card.boardId, { type: "comment.upserted", comment });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(card.id))! });
  await notifyMentions(card, comment, newlyMentioned, input.actor);
  if (input.actor.kind === "user" && !input.silent) {
    await enqueueTrigger({ card, kind: "comment_posted", actorUserId: input.actor.id, payload: { commentId: id } });
  }
  return comment;
}

export async function updateComment(id: string, input: { body: string; actor: Actor }): Promise<Comment> {
  const current = await getComment(id);
  if (!current) throw new Error("comment not found");
  if (current.body === input.body) return current;
  await db.insert(schema.commentRevisions).values({ id: newId(), commentId: id, body: current.body });
  await db
    .update(schema.comments)
    .set({ body: input.body, editedAt: new Date().toISOString() })
    .where(eq(schema.comments.id, id));
  let comment = (await getComment(id))!;
  const newlyMentioned = await syncMentions(comment, input.actor);
  comment = (await getComment(id))!;
  const card = (await getCard(comment.cardId))!;
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: input.actor, type: "comment.edited", payload: { commentId: id } });
  publish(card.boardId, { type: "comment.upserted", comment });
  await notifyMentions(card, comment, newlyMentioned, input.actor);
  if (input.actor.kind === "user") {
    await enqueueTrigger({ card, kind: "comment_edited", actorUserId: input.actor.id, payload: { commentId: id } });
  }
  return comment;
}

export async function addAttachment(input: {
  commentId: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
}): Promise<Attachment> {
  const id = newId();
  await db.insert(schema.attachments).values({ id, ...input });
  const row = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get())!;
  const comment = (await getComment(input.commentId))!;
  const card = (await getCard(comment.cardId))!;
  publish(card.boardId, { type: "comment.upserted", comment });
  return toAttachment(row);
}

export async function getAttachment(id: string): Promise<(Attachment & { sha256: string; cardId: string }) | null> {
  const row = await db
    .select({ a: schema.attachments, cardId: schema.comments.cardId })
    .from(schema.attachments)
    .innerJoin(schema.comments, eq(schema.attachments.commentId, schema.comments.id))
    .where(eq(schema.attachments.id, id))
    .get();
  if (!row) return null;
  return { ...toAttachment(row.a), sha256: row.a.sha256, cardId: row.cardId };
}
