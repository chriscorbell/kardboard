import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "../env.js";
import { hasBearer } from "../secrets.js";
import { endSessionOnExit } from "../services/session-end.js";
import { applyPreviewState, exchangePreviewCode, PreviewError, previewRoutes, settleBuildsInterruptedBy } from "../services/previews.js";

// Called by the runner when a container exits or a Preview build ends, and by the preview router for
// its routing table and its code exchange. Both reach the app over the control network, and the
// tunnel makes these routes reachable from the internet too, so a bearer token is their only guard.
// Each caller has its own and reaches only its own routes. The router sits beside branch-controlled
// Preview code, so it never holds the runner's token, which drives the service holding the Docker
// socket; with its own token it can read the routing table and spend a sign-in code, and no more.
export const internal = new Hono();

const holding =
  (token: () => string): MiddlewareHandler =>
  async (c, next) => {
    if (!hasBearer(c.req.header("authorization"), token())) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
const runnerOnly = holding(() => env.runnerToken);
const routerOnly = holding(() => env.routerToken);

// The preview router polls this: one entry per registered Preview, with the board epoch that a
// cookie must still match.
internal.get("/previews", routerOnly, async (c) => c.json(await previewRoutes()));

internal.post(
  "/previews/:id/state",
  runnerOnly,
  zValidator(
    "json",
    z.object({
      status: z.enum(["running", "failed"]),
      containerId: z.string().nullish(),
      target: z.string().nullish(),
      error: z.string().nullish(),
      // The commit the runner cloned. Absent when the clone itself failed.
      sha: z.string().nullish(),
      // The build this reports on, as the app named it in the request. Absent from an older runner.
      buildId: z.string().nullish(),
    }),
  ),
  async (c) => {
    // A stale report is still answered 2xx: the runner would otherwise retry it for a minute.
    const applied = await applyPreviewState(c.req.param("id"), c.req.valid("json"));
    return c.json({ ok: true, applied });
  },
);

// A restarted runner has lost every build its previous process was running, and says when it started
// so those Previews stop showing "building" now rather than at the stuck-build timeout. It also names
// the builds it has itself accepted since, which are not lost.
internal.post(
  "/previews/interrupted",
  runnerOnly,
  zValidator("json", z.object({ startedAt: z.string().datetime(), accepted: z.array(z.string()).default([]) })),
  async (c) => {
    const { startedAt, accepted } = c.req.valid("json");
    const settled = await settleBuildsInterruptedBy(startedAt, accepted);
    return c.json({ ok: true, settled });
  },
);

// Step two of the Preview sign-in redirect. The router never sees a kardboard credential; it hands
// over the single-use code and gets back one cookie for one host.
internal.post("/previews/exchange", routerOnly, zValidator("json", z.object({ code: z.string().min(1), host: z.string().min(1) })), async (c) => {
  const { code, host } = c.req.valid("json");
  try {
    return c.json(await exchangePreviewCode(code, host));
  } catch (err) {
    if (err instanceof PreviewError) return c.json({ error: err.message }, 403);
    throw err;
  }
});

// `oomKilled` is Docker's word that the container hit its memory limit; an older runner leaves it out.
internal.post("/sessions/:id/exit", runnerOnly, zValidator("json", z.object({ exitCode: z.number().int(), reason: z.string().optional(), oomKilled: z.boolean().optional() })), async (c) => {
  await endSessionOnExit(c.req.param("id"), c.req.valid("json"));
  return c.json({ ok: true });
});
