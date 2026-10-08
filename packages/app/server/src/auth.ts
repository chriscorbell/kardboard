import type { Context, MiddlewareHandler } from "hono";
import type { User } from "@kardboard/shared";
import { currentUser } from "./services/users.js";

export type AuthVariables = { user: User };
export type AppContext = Context<{ Variables: AuthVariables }>;

/**
 * Every request is the User. Nobody signs in: kardboard is reached only over the tailnet, which is
 * the boundary (ADR 0014), and knows the User only by the name they gave on first run. Until they
 * have, there is nobody to act as, and the API answers 409 `no_user` everywhere but `/me`. Agents
 * still present an Access token at `/mcp`, which is how the Board tells their work from the User's.
 */
export const requireUser: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const user = await currentUser();
  if (!user) return c.json({ error: "no_user" }, 409);
  c.set("user", user);
  await next();
};
