import { and, eq, inArray, isNull } from "drizzle-orm";
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

/**
 * Which User a Clerk identity signs in as. One already linked signs in by its Clerk id alone, whatever
 * addresses its Clerk account has since gained or lost. A first sign-in takes the row made for
 * `email`, which must be an address Clerk has verified, and only while no other Clerk user holds that
 * row: otherwise whoever later verifies an address the User dropped from their Clerk account would
 * sign in as them.
 */
export async function activateFromClerk(input: {
  clerkUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}): Promise<User | null> {
  const byClerk = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.clerkUserId, input.clerkUserId))
    .get();
  if (byClerk) {
    // Profile changes made in Clerk (avatar, name) flow back on the next token refresh.
    if (byClerk.avatarUrl !== (input.avatarUrl ?? null) || (input.name && byClerk.name !== input.name)) {
      await db
        .update(schema.users)
        .set({ avatarUrl: input.avatarUrl ?? null, name: input.name || byClerk.name })
        .where(eq(schema.users.id, byClerk.id));
      return getUser(byClerk.id);
    }
    return toUser(byClerk);
  }
  if (!input.email) return null;
  const allowed = await db.select().from(schema.users).where(eq(schema.users.email, input.email.toLowerCase())).get();
  if (!allowed || allowed.clerkUserId) return null;
  // Only while the row is still unlinked, so a second Clerk user signing in at the same moment
  // cannot take it over between the read and the write.
  const linked = await db
    .update(schema.users)
    .set({
      clerkUserId: input.clerkUserId,
      avatarUrl: input.avatarUrl ?? allowed.avatarUrl,
      name: allowed.name || input.name || allowed.email,
    })
    .where(and(eq(schema.users.id, allowed.id), isNull(schema.users.clerkUserId)))
    .returning()
    .get();
  return linked ? toUser(linked) : null;
}
