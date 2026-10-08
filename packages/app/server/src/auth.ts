import type { Context, MiddlewareHandler } from "hono";
import type { User } from "@kardboard/shared";
import { db, schema } from "./db/index.js";
import { toUser } from "./services/users.js";

export type AuthVariables = { user: User };
export type AppContext = Context<{ Variables: AuthVariables }>;

/**
 * Every request is the User. Like the other apps on minicore, kardboard has no sign-in of its own: it
 * is reached only from the home network and the tailnet, and that is the boundary (ADR 0014). Agents
 * still present an Access token at `/mcp`, which is how the Board tells their work from the User's.
 */
export const requireUser: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const row = await db.select().from(schema.users).get();
  if (!row) throw new Error("There is no User: the seed creates one at startup.");
  c.set("user", toUser(row));
  await next();
};
