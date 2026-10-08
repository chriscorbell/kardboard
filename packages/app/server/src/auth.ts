import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { activateFromClerk, toUser } from "./services/users.js";

export type AuthVariables = { user: User };
export type AppContext = Context<{ Variables: AuthVariables }>;

let clerk: { verifyToken: (t: string) => Promise<{ sub: string } | null>; fetchUser: (id: string) => Promise<{ email: string | null; name: string | null; avatarUrl: string | null }> } | null = null;

async function getClerk() {
  if (clerk) return clerk;
  const mod = await import("@clerk/backend");
  const client = mod.createClerkClient({ secretKey: env.clerkSecretKey, publishableKey: env.clerkPublishableKey });
  clerk = {
    verifyToken: (token) => verifySessionToken(token, { jwtKey: env.clerkJwtKey, secretKey: env.clerkSecretKey }),
    async fetchUser(id) {
      const u = await client.users.getUser(id);
      return {
        email: signInEmail(u),
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
        avatarUrl: u.imageUrl ?? null,
      };
    },
  };
  return clerk;
}

/**
 * Whose session a Clerk session token is, or null when it is not one this app accepts. With the
 * instance's PEM public key, `CLERK_JWT_KEY`, the check is networkless. Without it @clerk/backend
 * fetches the instance's keys from Clerk, with retries, whenever a token names a key id it has not
 * seen, so any anonymous caller can make the app call Clerk on every request.
 *
 * The PEM goes to `verifyJwt` rather than to `verifyToken` as `jwtKey`. They check the same claims and
 * signature, but `verifyToken` would keep a copy of the key under every key id a token names, and the
 * caller writes that id: each request could leave another copy behind, without limit.
 */
export async function verifySessionToken(token: string, keys: { jwtKey: string; secretKey: string }): Promise<{ sub: string } | null> {
  const authorizedParties = [env.publicUrl];
  try {
    const payload = keys.jwtKey
      ? await (await import("@clerk/backend/jwt")).verifyJwt(token, { key: keys.jwtKey, authorizedParties })
      : await (await import("@clerk/backend")).verifyToken(token, { secretKey: keys.secretKey, authorizedParties });
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

type ClerkEmailAddress = { id: string; emailAddress: string; verification: { status: string } | null };

// The address a Clerk user's first sign-in is matched to the User by: the primary address when
// Clerk has verified it, otherwise another verified one. An unverified address says nothing about
// who holds it, so a user with none is matched to no one.
export function signInEmail(user: { primaryEmailAddressId: string | null; emailAddresses: ClerkEmailAddress[] }): string | null {
  const verified = user.emailAddresses.filter((e) => e.verification?.status === "verified");
  return (verified.find((e) => e.id === user.primaryEmailAddressId) ?? verified[0])?.emailAddress ?? null;
}

// Only which User a Clerk identity is, never the User itself, which is read from the database on
// every request.
const clerkCache = new Map<string, { userId: string | null; expires: number }>();

export class NotInvitedError extends Error {}

async function resolveUser(c: Context): Promise<User | null> {
  if (env.authMode === "dev") {
    // Dev mode: every request is the seeded User.
    const row = await db.select().from(schema.users).get();
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
  c.set("user", user);
  await next();
};
