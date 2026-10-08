import fs from "node:fs";
import path from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { mimeEssence, type Attachment, type Comment } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, type Actor } from "./events.js";
import { getCard } from "./cards.js";

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
  return rows.map((r) => ({
    id: r.id,
    cardId: r.cardId,
    authorKind: r.authorKind,
    authorId: r.authorId,
    body: r.body,
    editedAt: r.editedAt,
    createdAt: r.createdAt,
    attachments: atts.filter((a) => a.commentId === r.id).map(toAttachment),
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

export async function createComment(input: {
  cardId: string;
  body: string;
  actor: Actor;
}): Promise<Comment> {
  const card = await getCard(input.cardId);
  if (!card) throw new Error("card not found");
  const id = newId();
  await db.insert(schema.comments).values({
    id,
    cardId: input.cardId,
    authorKind: input.actor.kind,
    authorId: input.actor.id,
    body: input.body,
  });
  const comment = (await getComment(id))!;
  await recordEvent({
    boardId: card.boardId,
    cardId: card.id,
    actor: input.actor,
    type: "comment.posted",
    payload: { commentId: id },
  });
  publish(card.boardId, { type: "comment.upserted", comment });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(card.id))! });
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
  const comment = (await getComment(id))!;
  const card = (await getCard(comment.cardId))!;
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: input.actor, type: "comment.edited", payload: { commentId: id } });
  publish(card.boardId, { type: "comment.upserted", comment });
  return comment;
}

// Where an uploaded file lives: named by its content, as the upload route writes it.
export function uploadPath(sha256: string): string {
  return path.join(env.dataDir, "uploads", sha256.slice(0, 2), sha256);
}

// A file deleted for good, a pasted secret say, also leaves the off-disk copy of the uploads. In the
// background, since the copy is often a network share; what the share's own snapshots already hold
// is beyond the app's reach.
function forgetBackupCopy(sha256: string): void {
  if (!env.backupCopyDir) return;
  void fs.promises
    .rm(path.join(env.backupCopyDir, "uploads", sha256.slice(0, 2), sha256), { force: true })
    .catch((err: Error) => console.error(`[backup] could not remove a deleted attachment from ${env.backupCopyDir}: ${err.message}`));
}

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

/**
 * Removes each of these uploaded files that no Attachment points at any more, and says how many went.
 * `offDiskCopy` removes the copy kept with the backups as well, for words that must not survive; left
 * there, a snapshot taken before the delete can still be restored with its attachments.
 */
export async function removeUnusedUploads(hashes: Iterable<string>, opts: { offDiskCopy: boolean }): Promise<number> {
  let removed = 0;
  for (const sha256 of hashes) {
    await underFileLock(sha256, async () => {
      const still = await db.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.sha256, sha256)).limit(1).get();
      if (still) return;
      fs.rmSync(uploadPath(sha256), { force: true });
      if (opts.offDiskCopy) forgetBackupCopy(sha256);
      removed++;
    });
  }
  return removed;
}

/**
 * Removes a Comment for good: its body, every earlier revision of it, its Attachments, and each
 * uploaded file no other Attachment still points at. A pasted secret is the usual reason. The event
 * log records that the Comment was deleted and whose it was, never what it said.
 */
export async function deleteComment(id: string, actor: Actor): Promise<void> {
  const current = await getComment(id);
  if (!current) throw new Error("comment not found");
  const card = (await getCard(current.cardId))!;
  const hashes = new Set(current.attachments.length > 0 ? (await db.select({ sha256: schema.attachments.sha256 }).from(schema.attachments).where(eq(schema.attachments.commentId, id))).map((a) => a.sha256) : []);
  await db.delete(schema.commentRevisions).where(eq(schema.commentRevisions.commentId, id));
  await db.delete(schema.attachments).where(eq(schema.attachments.commentId, id));
  await db.delete(schema.comments).where(eq(schema.comments.id, id));
  await removeUnusedUploads(hashes, { offDiskCopy: true });
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
  // Stored as the bare type, so everything that reads it later compares like with like.
  await db.insert(schema.attachments).values({ id, ...input, mime: mimeEssence(input.mime) });
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
