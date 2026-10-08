import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AccessToken, CreatedAccessToken } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";

// Every Access token starts with this, so a secret scanner can find one pasted where it should not be.
export const ACCESS_TOKEN_PREFIX = "kbat_";

// How stale the recorded last use may get before a request writes it again: an agent calls tools in
// bursts, and one write per burst says as much as one per call.
const LAST_USED_GRAIN_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function toAccessToken(row: typeof schema.accessTokens.$inferSelect): AccessToken {
  return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

/** The tokens still in force, newest first. */
export async function listAccessTokens(): Promise<AccessToken[]> {
  const rows = await db.select().from(schema.accessTokens).where(isNull(schema.accessTokens.revokedAt)).orderBy(desc(schema.accessTokens.createdAt));
  return rows.map(toAccessToken);
}

/** Makes a token that reaches every Board. The secret is returned here and never again. */
export async function createAccessToken(name: string): Promise<CreatedAccessToken> {
  const secret = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = newId();
  await db.insert(schema.accessTokens).values({ id, name, tokenHash: hash(secret) });
  console.log(`[tokens] created ${id} (${JSON.stringify(name)})`);
  const row = (await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, id)).get())!;
  return { accessToken: toAccessToken(row), secret };
}

/**
 * Revoking keeps the row with its name, so the events a token signed still say which one it was; the
 * token itself stops working at once.
 */
export async function revokeAccessToken(id: string): Promise<boolean> {
  const revoked = await db
    .update(schema.accessTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(schema.accessTokens.id, id), isNull(schema.accessTokens.revokedAt)))
    .returning({ id: schema.accessTokens.id });
  if (revoked.length > 0) console.log(`[tokens] revoked ${id}`);
  return revoked.length > 0;
}

/** The token a request carries, if it is one still in force, and records that it was used. */
export async function findAccessToken(secret: string): Promise<AccessToken | null> {
  if (!secret.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const row = await db.select().from(schema.accessTokens).where(and(eq(schema.accessTokens.tokenHash, hash(secret)), isNull(schema.accessTokens.revokedAt))).get();
  if (!row) return null;
  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > LAST_USED_GRAIN_MS) {
    await db.update(schema.accessTokens).set({ lastUsedAt: now.toISOString() }).where(eq(schema.accessTokens.id, row.id));
    row.lastUsedAt = now.toISOString();
  }
  return toAccessToken(row);
}
