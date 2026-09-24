import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { extractMentionHandles, type Attachment, type Comment, type User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { enqueueTrigger } from "./orchestrator.js";
import { getCard } from "./cards.js";
import { findUsersByHandles } from "./users.js";
import { canBeNotified, forgetCommentTraces, notifyMentions } from "./notifications.js";

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

// A Mention is recorded only for someone who can open the Card. Handles are global, so a handle
// alone would otherwise reach Users of other Boards and revoked Users.
async function syncMentions(comment: Comment, boardId: string, actor: Actor): Promise<string[]> {
  const handles = extractMentionHandles(comment.body);
  const users = await findUsersByHandles(handles);
  const existing = new Set(comment.mentions);
  const fresh: User[] = [];
  for (const u of users) {
    if (existing.has(u.id) || u.id === actor.id) continue;
    if (await canBeNotified(u, boardId)) fresh.push(u);
  }
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
  // kardboard's own notices quote what went wrong in the Agent's words, which can name people; the
  // Agent already reached them, and the notice's own notification goes to who it concerns.
  const newlyMentioned = input.actor.kind === "system" ? [] : await syncMentions(comment, card.boardId, input.actor);
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
  const card = (await getCard(comment.cardId))!;
  // kardboard's own notices quote what went wrong in the Agent's words, which can name people; the
  // Agent already reached them, and the notice's own notification goes to who it concerns.
  const newlyMentioned = input.actor.kind === "system" ? [] : await syncMentions(comment, card.boardId, input.actor);
  comment = (await getComment(id))!;
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: input.actor, type: "comment.edited", payload: { commentId: id } });
  publish(card.boardId, { type: "comment.upserted", comment });
  await notifyMentions(card, comment, newlyMentioned, input.actor);
  if (input.actor.kind === "user") {
    await enqueueTrigger({ card, kind: "comment_edited", actorUserId: input.actor.id, payload: { commentId: id } });
  }
  return comment;
}

// Where an uploaded file lives: named by its content, as the upload route writes it.
export function uploadPath(sha256: string): string {
  return path.join(env.dataDir, "uploads", sha256.slice(0, 2), sha256);
}

/**
 * Removes a Comment for good: its body, every earlier revision of it, its Mentions, its
 * Attachments, and each uploaded file no other Attachment still points at. A pasted secret is the
 * usual reason, so the mention notifications that quoted it go as well; an email already sent
 * cannot be recalled. The event log records that the Comment was deleted and whose it was, never
 * what it said. Not a Trigger: taking words back is not a request for work.
 */
// Uploads are stored once per content hash, so writing a file for a new Attachment and removing
// the file once the last Attachment using it is deleted must not interleave, or the new one would
// point at nothing. One process owns the data directory (ADR 0004); this chain orders the two per hash.
const fileLocks = new Map<string, Promise<unknown>>();
export function underFileLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const run = (fileLocks.get(sha256) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => undefined);
  fileLocks.set(sha256, settled);
  void settled.then(() => {
    if (fileLocks.get(sha256) === settled) fileLocks.delete(sha256);
  });
  return run;
}

export async function deleteComment(id: string, actor: Actor): Promise<void> {
  const current = await getComment(id);
  if (!current) throw new Error("comment not found");
  const card = (await getCard(current.cardId))!;
  const revisions = await db.select({ body: schema.commentRevisions.body }).from(schema.commentRevisions).where(eq(schema.commentRevisions.commentId, id));
  const hashes = new Set(current.attachments.length > 0 ? (await db.select({ sha256: schema.attachments.sha256 }).from(schema.attachments).where(eq(schema.attachments.commentId, id))).map((a) => a.sha256) : []);
  await db.delete(schema.commentRevisions).where(eq(schema.commentRevisions.commentId, id));
  await db.delete(schema.attachments).where(eq(schema.attachments.commentId, id));
  await db.delete(schema.mentions).where(eq(schema.mentions.commentId, id));
  await db.delete(schema.comments).where(eq(schema.comments.id, id));
  await forgetCommentTraces(id, card.id, [current.body, ...revisions.map((r) => r.body)]);
  // A Session not yet started for this Comment has nothing left to read: its Trigger goes with it.
  await db
    .delete(schema.triggers)
    .where(and(eq(schema.triggers.cardId, card.id), eq(schema.triggers.status, "pending"), sql`json_extract(${schema.triggers.payload}, '$.commentId') = ${id}`));
  for (const sha256 of hashes) {
    await underFileLock(sha256, async () => {
      const still = await db.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.sha256, sha256)).limit(1).get();
      if (!still) fs.rmSync(uploadPath(sha256), { force: true });
    });
  }
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor,
    type: "comment.deleted",
    payload: { commentId: id, authorKind: current.authorKind, authorId: current.authorId },
  });
  publish(card.boardId, { type: "comment.removed", commentId: id, cardId: card.id });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(card.id))! });
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
