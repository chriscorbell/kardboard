import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "../env.js";
import { endSessionOnExit } from "../services/session-end.js";
import { applyPreviewState, exchangePreviewCode, PreviewError, previewRoutes, settleBuildsInterruptedBy } from "../services/previews.js";

// Called by the runner when a container exits, and by the preview router for its routing table and
// its code exchange. Both reach the app over the control network with the shared runner token.
export const internal = new Hono();

internal.use("*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  if (!env.runnerToken || header !== `Bearer ${env.runnerToken}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

// The preview router polls this: one entry per registered Preview, with the board epoch that a
// cookie must still match.
internal.get("/previews", async (c) => c.json(await previewRoutes()));

internal.post(
  "/previews/:id/state",
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
  zValidator("json", z.object({ startedAt: z.string().datetime(), accepted: z.array(z.string()).default([]) })),
  async (c) => {
    const { startedAt, accepted } = c.req.valid("json");
    const settled = await settleBuildsInterruptedBy(startedAt, accepted);
    return c.json({ ok: true, settled });
  },
);

// Step two of the Preview sign-in redirect. The router never sees a kardboard credential; it hands
// over the single-use code and gets back one cookie for one host.
internal.post("/previews/exchange", zValidator("json", z.object({ code: z.string().min(1), host: z.string().min(1) })), async (c) => {
  const { code, host } = c.req.valid("json");
  try {
    return c.json(await exchangePreviewCode(code, host));
  } catch (err) {
    if (err instanceof PreviewError) return c.json({ error: err.message }, 403);
    throw err;
  }
});

// `oomKilled` is Docker's word that the container hit its memory limit; an older runner leaves it out.
internal.post("/sessions/:id/exit", zValidator("json", z.object({ exitCode: z.number().int(), reason: z.string().optional(), oomKilled: z.boolean().optional() })), async (c) => {
  await endSessionOnExit(c.req.param("id"), c.req.valid("json"));
  return c.json({ ok: true });
});
