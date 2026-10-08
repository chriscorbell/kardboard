import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { toUser } from "./services/users.js";

export type AuthVariables = { user: User };
export type AppContext = Context<{ Variables: AuthVariables }>;

/**
 * A header value as Tailscale Serve writes it: plain ASCII, or for anything else an RFC 2047 encoded
 * word such as `=?utf-8?q?Ren=C3=A9e?=`. Both `q` and `b` encodings are read; an encoded word that
 * cannot be read comes back as written rather than failing the request.
 */
export function decodeHeaderWord(value: string): string {
  return value.replace(/=\?([\w-]+)\?([qQbB])\?([^?]*)\?=/g, (word, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return word;
    }
  });
}

export class NotAllowedError extends Error {}

/**
 * Who a request is. In dev mode, always the seeded User. Otherwise the request came through Tailscale
 * Serve on the same host, the only way in, since the container listens on loopback alone. Serve adds
 * the identity of the tailnet user behind the request in `Tailscale-User-Login`, removing any such
 * header the client sent, so the header is the sign-in: the User is let in when it is
 * `KARDBOARD_TAILSCALE_LOGIN`, and their name and avatar follow their Tailscale profile.
 */
async function resolveUser(c: Context): Promise<User | null> {
  const row = await db.select().from(schema.users).get();
  if (env.authMode === "dev") return row ? toUser(row) : null;
  const login = c.req.header("tailscale-user-login");
  if (!login) return null;
  if (login.trim().toLowerCase() !== env.tailscaleLogin.toLowerCase()) throw new NotAllowedError();
  if (!row) return null;
  const name = decodeHeaderWord(c.req.header("tailscale-user-name") ?? "").trim() || row.name;
  const avatarUrl = c.req.header("tailscale-user-profile-pic")?.trim() || null;
  if (name !== row.name || avatarUrl !== row.avatarUrl) {
    await db.update(schema.users).set({ name, avatarUrl }).where(eq(schema.users.id, row.id));
    return toUser({ ...row, name, avatarUrl });
  }
  return toUser(row);
}

export const requireUser: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  let user: User | null;
  try {
    user = await resolveUser(c);
  } catch (err) {
    if (err instanceof NotAllowedError) return c.json({ error: "not_allowed" }, 403);
    throw err;
  }
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  await next();
};
