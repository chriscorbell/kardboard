import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AccessToken, CreatedAccessToken } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { recordEvent, type Actor } from "./events.js";

// Every Access token starts with this, so it can be told from a Session's token at a glance, and so a
// secret scanner can find one pasted where it should not be.
export const ACCESS_TOKEN_PREFIX = "kbat_";

// How stale the recorded last use may get before a request writes it again: an agent calls tools in
// bursts, and one write per burst says as much as one per call.
const LAST_USED_GRAIN_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function toAccessToken(row: typeof schema.accessTokens.$inferSelect): AccessToken {
  return { id: row.id, boardId: row.boardId, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

export class AccessTokenRefused extends Error {
  status = 409 as const;
}

export async function listAccessTokens(boardId: string): Promise<AccessToken[]> {
  const rows = await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.boardId, boardId)).orderBy(desc(schema.accessTokens.createdAt));
  return rows.map(toAccessToken);
}

/** Makes a token for a Board without Sessions. The secret is returned here and never again. */
export async function createAccessToken(boardId: string, name: string, actor: Actor): Promise<CreatedAccessToken> {
  const board = await db.select({ sessionsEnabled: schema.boards.sessionsEnabled }).from(schema.boards).where(eq(schema.boards.id, boardId)).get();
  if (!board) throw new Error("board not found");
  // A Board that runs Sessions already has the Agent at work; a second one acting under its name
  // would race the Sessions for its Cards. See ADR 0010.
  if (board.sessionsEnabled) throw new AccessTokenRefused("This board runs sessions. Turn them off to work it from your own agent.");
  const secret = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = newId();
  await db.insert(schema.accessTokens).values({ id, boardId, name, tokenHash: hash(secret) });
  await recordEvent({ boardId, actor, type: "access_token.created", payload: { accessTokenId: id, name } });
  const row = (await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, id)).get())!;
  return { accessToken: toAccessToken(row), secret };
}

/** Revoking is deleting: the event log keeps which token it was and what it was called. */
export async function revokeAccessToken(boardId: string, id: string, actor: Actor): Promise<boolean> {
  const removed = await db
    .delete(schema.accessTokens)
    .where(and(eq(schema.accessTokens.id, id), eq(schema.accessTokens.boardId, boardId)))
    .returning({ name: schema.accessTokens.name });
  if (removed.length === 0) return false;
  await recordEvent({ boardId, actor, type: "access_token.revoked", payload: { accessTokenId: id, name: removed[0]!.name } });
  return true;
}

/** The token a request carries, if it is one, and records that it was used. */
export async function findAccessToken(secret: string): Promise<AccessToken | null> {
  if (!secret.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const row = await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.tokenHash, hash(secret))).get();
  if (!row) return null;
  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > LAST_USED_GRAIN_MS) {
    await db.update(schema.accessTokens).set({ lastUsedAt: now.toISOString() }).where(eq(schema.accessTokens.id, row.id));
    row.lastUsedAt = now.toISOString();
  }
  return toAccessToken(row);
}
