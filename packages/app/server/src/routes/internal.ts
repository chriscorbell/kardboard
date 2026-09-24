import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { env } from "../env.js";
import { endSessionOnExit } from "../services/session-end.js";
import { applyPreviewState, exchangePreviewCode, failBuildsInterruptedBy, PreviewError, previewRoutes } from "../services/previews.js";

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
    }),
  ),
  async (c) => {
    await applyPreviewState(c.req.param("id"), c.req.valid("json"));
    return c.json({ ok: true });
  },
);

// A restarted runner has lost every build its previous process was running, and says when it started
// so those Previews stop showing "building" now rather than at the stuck-build timeout.
internal.post("/previews/interrupted", zValidator("json", z.object({ startedAt: z.string().datetime() })), async (c) => {
  const failed = await failBuildsInterruptedBy(c.req.valid("json").startedAt);
  return c.json({ ok: true, failed });
});

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
