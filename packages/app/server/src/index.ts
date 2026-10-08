import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { appShell, securityHeaders } from "./headers.js";
import { client, runMigrations } from "./db/index.js";
import { api } from "./routes/api.js";
import { mcp } from "./routes/mcp.js";
import { copySnapshotOffDisk, snapshotBeforeMigrations, startBackupScheduler } from "./services/backup.js";
import { redactTokens, startLogFile } from "./services/logfile.js";
import { ensureSeed } from "./seed.js";

// First, so the boot itself, migrations included, is in the kept log.
startLogFile(env.logDir, env.logKeepDays);

const app = new Hono();
// First, so every response carries them, the health check and redirects included. An authenticated
// MCP call is the one exception: its transport writes to the socket itself, and only agents read it.
app.use("*", securityHeaders());
// Registered ahead of the request logger, so the container's health check, which calls it every 30
// seconds, does not fill the log.
//
// The app is healthy when it can read its database; that is the one thing it cannot serve without.
app.get("/healthz", async (c) => {
  try {
    await Promise.race([
      client.execute("SELECT count(*) FROM sqlite_master"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2_000).unref()),
    ]);
  } catch {
    return c.json({ ok: false, db: "unavailable" }, 503);
  }
  return c.json({ ok: true, db: "ok" });
});
// Any `token=` in a query is kept out of the log, which lasts two weeks.
app.use("*", logger((msg) => console.log(redactTokens(msg))));
app.route("/api", api);
app.route("/mcp", mcp);

// Production: serve the built client. In dev, Vite serves it and proxies /api here.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../client");
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  const shell = appShell(fs.readFileSync(path.join(clientDir, "index.html"), "utf8"));
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), clientDir) }));
  app.use("/brand/*", serveStatic({ root: path.relative(process.cwd(), clientDir) }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api") || c.req.path.startsWith("/mcp")) return c.notFound();
    return shell(c);
  });
}

app.onError((err, c) => {
  // A malformed JSON body and the like are the caller's mistake, not a server fault.
  if (err instanceof HTTPException && err.status < 500) return c.json({ error: err.message || "bad request" }, err.status);
  console.error(err);
  return c.json({ error: "internal", message: env.isProduction ? undefined : err.message }, 500);
});

// A new image with schema changes gets a snapshot of the database as the old image left it.
const preMigrate = await snapshotBeforeMigrations();
await runMigrations();
await ensureSeed();
startBackupScheduler();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`kardboard app listening on http://localhost:${info.port}`);
  // Only once the app answers: the copy goes to a network share, which can be slow or gone.
  if (preMigrate) void copySnapshotOffDisk(preMigrate.name);
});
