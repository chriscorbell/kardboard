import { eq, inArray } from "drizzle-orm";
import type { EmailPreference, User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";

export function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function listUsers(): Promise<User[]> {
  const rows = await db.select().from(schema.users).orderBy(schema.users.createdAt);
  return rows.map(toUser);
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

// A User's own settings, which only they see: they are not part of the User everyone else is shown.
export type UserPreferences = { emailPreference: EmailPreference; onboardedAt: string | null };

export async function getPreferences(id: string): Promise<UserPreferences> {
  const row = await db
    .select({ emailPreference: schema.users.emailPreference, onboardedAt: schema.users.onboardedAt })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
  return row ?? { emailPreference: "all", onboardedAt: null };
}

export async function updatePreferences(id: string, input: { emailPreference?: EmailPreference; onboarded?: boolean }): Promise<UserPreferences> {
  const patch: Partial<typeof schema.users.$inferInsert> = {};
  if (input.emailPreference) patch.emailPreference = input.emailPreference;
  // Dismissing twice keeps the first time; `false` brings the explainer back.
  if (input.onboarded === true) patch.onboardedAt = (await getPreferences(id)).onboardedAt ?? new Date().toISOString();
  if (input.onboarded === false) patch.onboardedAt = null;
  if (Object.keys(patch).length > 0) await db.update(schema.users).set(patch).where(eq(schema.users.id, id));
  return getPreferences(id);
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const row = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .get();
  return row ? toUser(row) : null;
}

export async function findUsersByHandles(handles: string[]): Promise<User[]> {
  if (handles.length === 0) return [];
  const rows = await db.select().from(schema.users).where(inArray(schema.users.handle, handles));
  return rows.map(toUser);
}

async function uniqueHandle(email: string): Promise<string> {
  const base =
    email
      .split("@")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 30) || "user";
  let candidate = base;
  for (let i = 2; ; i++) {
    const clash = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.handle, candidate))
      .get();
    if (!clash) return candidate;
    candidate = `${base}${i}`;
  }
}

export async function inviteUser(input: {
  email: string;
  name: string;
  role: "admin" | "member";
}): Promise<User> {
  const email = input.email.toLowerCase();
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.status === "revoked") {
      await db.update(schema.users).set({ status: "invited" }).where(eq(schema.users.id, existing.id));
      return { ...existing, status: "invited" };
    }
    return existing;
  }
  const id = newId();
  await db.insert(schema.users).values({
    id,
    email,
    handle: await uniqueHandle(email),
    name: input.name,
    role: input.role,
    status: "invited",
  });
  return (await getUser(id))!;
}

export async function setUserStatus(id: string, status: "invited" | "active" | "revoked"): Promise<void> {
  await db.update(schema.users).set({ status }).where(eq(schema.users.id, id));
}

export async function activateFromClerk(input: {
  clerkUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}): Promise<User | null> {
  const byClerk = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.clerkUserId, input.clerkUserId))
    .get();
  if (byClerk) {
    if (byClerk.status === "revoked") return null;
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
  const invited = await findUserByEmail(input.email);
  if (!invited || invited.status === "revoked") return null;
  await db
    .update(schema.users)
    .set({
      clerkUserId: input.clerkUserId,
      status: "active",
      avatarUrl: input.avatarUrl ?? invited.avatarUrl,
      name: invited.name || input.name || invited.email,
    })
    .where(eq(schema.users.id, invited.id));
  return getUser(invited.id);
}
