import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { activateFromClerk, toUser } from "./services/users.js";

export type AuthVariables = { user: User };
export type AppContext = Context<{ Variables: AuthVariables }>;

let clerk: { verifyToken: (t: string) => Promise<{ sub: string } | null>; fetchUser: (id: string) => Promise<{ email: string; name: string | null; avatarUrl: string | null }> } | null = null;

async function getClerk() {
  if (clerk) return clerk;
  const mod = await import("@clerk/backend");
  const client = mod.createClerkClient({ secretKey: env.clerkSecretKey, publishableKey: env.clerkPublishableKey });
  clerk = {
    async verifyToken(token) {
      try {
        const payload = await mod.verifyToken(token, { secretKey: env.clerkSecretKey, authorizedParties: [env.publicUrl] });
        return { sub: payload.sub };
      } catch {
        return null;
      }
    },
    async fetchUser(id) {
      const u = await client.users.getUser(id);
      const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
      return {
        email: primary?.emailAddress ?? "",
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
        avatarUrl: u.imageUrl ?? null,
      };
    },
  };
  return clerk;
}

// Only which User a Clerk identity is, never the User itself: status and role are read from the
// database on every request, so revoking someone or changing their role takes effect at once.
const clerkCache = new Map<string, { userId: string | null; expires: number }>();

export class NotInvitedError extends Error {}

async function resolveUser(c: Context): Promise<User | null> {
  if (env.authMode === "dev") {
    // Dev mode: every request is the seeded admin, or a user chosen with the X-Dev-User header (email).
    const email = c.req.header("x-dev-user");
    const row = email
      ? await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).get()
      : await db.select().from(schema.users).where(eq(schema.users.role, "admin")).get();
    return row ? toUser(row) : null;
  }
  const header = c.req.header("authorization") ?? "";
  // EventSource cannot set headers, so the SSE route may carry the token as a query parameter.
  const token = header.startsWith("Bearer ") ? header.slice(7) : (c.req.path.endsWith("/events") ? (c.req.query("token") ?? null) : null);
  if (!token) return null;
  const k = await getClerk();
  const verified = await k.verifyToken(token);
  if (!verified) return null;
  const cached = clerkCache.get(verified.sub);
  if (cached && cached.expires > Date.now()) {
    if (!cached.userId) throw new NotInvitedError();
    const row = await db.select().from(schema.users).where(eq(schema.users.id, cached.userId)).get();
    if (row) return toUser(row);
  }
  const profile = await k.fetchUser(verified.sub);
  const user = await activateFromClerk({ clerkUserId: verified.sub, ...profile });
  clerkCache.set(verified.sub, { userId: user?.id ?? null, expires: Date.now() + 5 * 60_000 });
  if (!user) throw new NotInvitedError();
  return user;
}

// Re-read the profile from Clerk right now, bypassing the cache. Used after the user edits it.
export async function refreshFromClerk(user: User): Promise<User> {
  if (env.authMode !== "clerk") return user;
  const row = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (!row?.clerkUserId) return user;
  const k = await getClerk();
  const profile = await k.fetchUser(row.clerkUserId);
  const updated = await activateFromClerk({ clerkUserId: row.clerkUserId, ...profile });
  clerkCache.set(row.clerkUserId, { userId: updated?.id ?? null, expires: Date.now() + 5 * 60_000 });
  return updated ?? user;
}

export const requireUser: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  let user: User | null;
  try {
    user = await resolveUser(c);
  } catch (err) {
    if (err instanceof NotInvitedError) return c.json({ error: "not_invited" }, 403);
    throw err;
  }
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  if (user.status === "revoked") return c.json({ error: "not_invited" }, 403);
  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
};
