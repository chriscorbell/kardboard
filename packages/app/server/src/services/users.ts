import { eq, inArray } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";

export function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
  };
}

export async function getUser(id: string): Promise<User | null> {
  const row = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  return row ? toUser(row) : null;
}

export async function getUsersByIds(ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, toUser(r)]));
}

// The User's own settings, beside the User everything else is shown.
export type UserPreferences = { onboardedAt: string | null };

export async function getPreferences(id: string): Promise<UserPreferences> {
  const row = await db.select({ onboardedAt: schema.users.onboardedAt }).from(schema.users).where(eq(schema.users.id, id)).get();
  return row ?? { onboardedAt: null };
}

export async function updatePreferences(id: string, input: { onboarded?: boolean }): Promise<UserPreferences> {
  // Dismissing twice keeps the first time; `false` brings the explainer back.
  if (input.onboarded === true) {
    const onboardedAt = (await getPreferences(id)).onboardedAt ?? new Date().toISOString();
    await db.update(schema.users).set({ onboardedAt }).where(eq(schema.users.id, id));
  }
  if (input.onboarded === false) await db.update(schema.users).set({ onboardedAt: null }).where(eq(schema.users.id, id));
  return getPreferences(id);
}
