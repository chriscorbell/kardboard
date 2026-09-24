import { serve } from "@hono/node-server";
import { Hono } from "hono";
import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { codexWiring } from "./codex.js";
import { pruneSupersededImages } from "./images.js";
import { ID_PATTERN, readLogSlice } from "./logs.js";
import { createSessionNetwork, prunePreviewNetworks, pruneSessionNetworks, removeSessionNetwork } from "./networks.js";
import { buildAndRunPreview, PreviewCancelled, PreviewError, removePreview, type PreviewRequest } from "./previews.js";
import { resumeLogFrom, runningSessions } from "./reattach.js";

// The runner is the only process with the Docker socket. It knows how to do exactly two things:
// run a Session container from an approved image with fixed limits, and stop or remove one.
// It listens on the stack's internal network only and requires the shared token.

const env = {
  port: Number(process.env.PORT ?? "3071"),
  token: process.env.KARDBOARD_RUNNER_TOKEN ?? "",
  appUrl: (process.env.KARDBOARD_APP_URL ?? "http://app:3070").replace(/\/$/, ""),
  mcpUrl: (process.env.KARDBOARD_MCP_URL ?? "http://app:3070/mcp").replace(/\/$/, ""),
  egressUrl: (process.env.KARDBOARD_EGRESS_URL ?? "http://egress:8787").replace(/\/$/, ""),
  defaultImage: process.env.KARDBOARD_AGENT_IMAGE ?? "ghcr.io/chriscorbell/kardboard-agent:latest",
  workloadNetwork: process.env.KARDBOARD_WORKLOAD_NETWORK ?? "kardboard_workload",
  // Each Session gets a network of its own, holding only that Session and the containers on
  // `workload` it is meant to reach, so two Sessions cannot see each other. Set this to `shared`
  // to put Sessions back on `workload` together if the per-session wiring ever has to be backed out.
  perSessionNetwork: (process.env.KARDBOARD_SESSION_NETWORK ?? "per-session") !== "shared",
  // Previews are branch-controlled code, so each gets a network of its own: the router can reach
  // them and they can reach the internet, but not the app, the egress proxy, the runner, or each
  // other. This is the network the router lives on, which each Preview's network is peered from.
  previewNetwork: process.env.KARDBOARD_PREVIEW_NETWORK ?? "kardboard_preview",
  logDir: process.env.KARDBOARD_LOG_DIR ?? "/data/logs",
  logRetentionDays: Number(process.env.KARDBOARD_LOG_RETENTION_DAYS ?? "14"),
  memoryBytes: Number(process.env.KARDBOARD_SESSION_MEMORY_BYTES ?? String(4 * 1024 * 1024 * 1024)),
  nanoCpus: Number(process.env.KARDBOARD_SESSION_NANO_CPUS ?? String(2e9)),
  pidsLimit: Number(process.env.KARDBOARD_SESSION_PIDS_LIMIT ?? "1024"),
  previewMemoryBytes: Number(process.env.KARDBOARD_PREVIEW_MEMORY_BYTES ?? String(1024 * 1024 * 1024)),
  previewNanoCpus: Number(process.env.KARDBOARD_PREVIEW_NANO_CPUS ?? String(1e9)),
  previewPidsLimit: Number(process.env.KARDBOARD_PREVIEW_PIDS_LIMIT ?? "512"),
  previewBuildMemoryBytes: Number(process.env.KARDBOARD_PREVIEW_BUILD_MEMORY_BYTES ?? String(2 * 1024 * 1024 * 1024)),
  previewBuildTimeoutMinutes: Number(process.env.KARDBOARD_PREVIEW_BUILD_TIMEOUT_MINUTES ?? "15"),
  // A path on the Docker host: the runner never opens it, it only names it in a bind.
  codexAuthFile: process.env.CODEX_AUTH_FILE ?? "",
  codexViaEgress: /^(1|true|yes)$/i.test(process.env.KARDBOARD_CODEX_VIA_EGRESS ?? ""),
};

if (!env.token) {
  console.error("KARDBOARD_RUNNER_TOKEN is required");
  process.exit(1);
}
fs.mkdirSync(env.logDir, { recursive: true });

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.path === "/healthz") return next();
  if ((c.req.header("authorization") ?? "") !== `Bearer ${env.token}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/healthz", async (c) => {
  try {
    await docker.ping();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});

const startSchema = z.object({
  sessionId: z.string().regex(ID_PATTERN),
  boardSlug: z.string(),
  provider: z.enum(["claude", "codex"]),
  model: z.string().nullable().default(null),
  reasoning: z.string().nullable().default(null),
  image: z.string().nullable(),
  repoUrl: z.string().nullable(),
  branch: z.string().nullable(),
  token: z.string(),
  wallClockMinutes: z.number(),
  prompt: z.string(),
  githubToken: z.string().nullable().default(null),
  gitName: z.string().default("kardboard"),
  gitEmail: z.string().default("kardboard@users.noreply.github.com"),
});

const containerName = (sessionId: string) => `kardboard-session-${sessionId}`;

// Nothing long-lived runs the agent image, so no watcher refreshes it. Pull before every start:
// a no-op when the tag is current, and a fresh image the minute CI publishes one. If the registry
// is unreachable, an image already on the host still starts the Session.
async function ensureImage(image: string): Promise<void> {
  try {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())));
  } catch (err) {
    const present = await docker.getImage(image).inspect().catch(() => null);
    if (!present) throw err;
    console.warn(`[runner] could not refresh ${image}; using the local copy`, (err as Error).message);
  }
}

// Session containers that exited while the runner was down never had their exit reported or got
// their post-exit cleanup. The exit code is still on the container until it is removed.
async function pruneExitedSessions(): Promise<void> {
  const list = await docker.listContainers({ all: true, filters: { label: ["kardboard.session"], status: ["exited", "dead"] } });
  for (const c of list) {
    const container = docker.getContainer(c.Id);
    const sessionId = c.Labels["kardboard.session"];
    const info = await container.inspect().catch(() => null);
    if (sessionId && info) await reportExit(sessionId, info.State.ExitCode);
    await container.remove({ force: true }).catch(() => {});
    console.log(`[runner] removed exited ${c.Names[0] ?? c.Id}`);
  }
}

// See reattach.ts: after a restart, nothing is waiting on the Session containers still running.
async function reattachRunningSessions(): Promise<void> {
  for (const s of await runningSessions(docker)) {
    watchContainer(s.sessionId, docker.getContainer(s.containerId), resumeLogFrom(path.join(env.logDir, `${s.sessionId}.log`)));
    console.log(`[runner] re-attached to ${s.name}`);
  }
}

async function reportExit(sessionId: string, exitCode: number, reason?: string) {
  try {
    await fetch(`${env.appUrl}/api/internal/sessions/${sessionId}/exit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ exitCode, reason }),
    });
  } catch (err) {
    console.error(`[runner] could not report exit for ${sessionId}`, err);
  }
}

// Sessions whose container this process is already waiting on, so a start and the boot-time
// re-attach cannot both watch one container and write its log twice.
const watching = new Set<string>();

// `since` resumes a log this runner was following before it restarted.
function watchContainer(sessionId: string, container: Docker.Container, since?: string) {
  if (watching.has(sessionId)) return;
  watching.add(sessionId);
  const logPath = path.join(env.logDir, `${sessionId}.log`);
  const out = fs.createWriteStream(logPath, { flags: "a" });
  void container.logs({ follow: true, stdout: true, stderr: true, timestamps: true, ...(since ? { since } : {}) }).then((stream) => {
    container.modem.demuxStream(stream, out, out);
    stream.on("end", () => out.end());
  });
  void container
    .wait()
    .then(async (res) => {
      await reportExit(sessionId, res.StatusCode);
      await container.remove({ force: true }).catch(() => {});
      await removeSessionNetwork(docker, sessionId).catch(() => {});
    })
    .catch((err) => console.error(`[runner] wait failed for ${sessionId}`, err))
    .finally(() => watching.delete(sessionId));
}

app.post("/sessions", async (c) => {
  const parsed = startSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const req = parsed.data;
  const name = containerName(req.sessionId);

  // Idempotent: a retry after a lost response returns the existing container.
  const existing = docker.getContainer(name);
  const info = await existing.inspect().catch(() => null);
  if (info) return c.json({ containerId: info.Id });

  // Refuse a Codex Session with no way to reach the provider rather than starting a container that
  // can only fail: it would hold a concurrency slot and report an exit the Card cannot explain.
  const codex = req.provider === "codex" ? codexWiring({ viaEgress: env.codexViaEgress, egressUrl: env.egressUrl, authFile: env.codexAuthFile }) : { env: [], binds: [] };
  if ("error" in codex) {
    console.error(`[runner] refusing codex session ${req.sessionId}: ${codex.error}`);
    return c.json({ error: codex.error }, 400);
  }

  const image = req.image ?? env.defaultImage;
  await ensureImage(image);
  void pruneSupersededImages(docker, image)
    .then((n) => n && console.log(`[runner] pruned ${n} superseded image layer(s) of ${image}`))
    .catch((err: Error) => console.warn(`[runner] could not prune old copies of ${image}`, err.message));
  const envList = [
    `KARDBOARD_SESSION_ID=${req.sessionId}`,
    `KARDBOARD_TOKEN=${req.token}`,
    `KARDBOARD_MCP_URL=${env.mcpUrl}`,
    `KARDBOARD_PROVIDER=${req.provider}`,
    `KARDBOARD_MODEL=${req.model ?? ""}`,
    `KARDBOARD_REASONING=${req.reasoning ?? ""}`,
    `KARDBOARD_REPO_URL=${req.repoUrl ?? ""}`,
    `KARDBOARD_BRANCH=${req.branch ?? ""}`,
    `KARDBOARD_WALL_CLOCK_MINUTES=${req.wallClockMinutes}`,
    `KARDBOARD_GIT_NAME=${req.gitName}`,
    `KARDBOARD_GIT_EMAIL=${req.gitEmail}`,
    ...(req.githubToken ? [`GITHUB_TOKEN=${req.githubToken}`, `GH_TOKEN=${req.githubToken}`] : []),
    // Claude Code talks to the provider through the egress proxy, which holds the real credential.
    `ANTHROPIC_BASE_URL=${env.egressUrl}/anthropic`,
    `ANTHROPIC_API_KEY=kardboard-egress`,
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
    ...codex.env,
  ];
  const binds = [...codex.binds];

  // Refuse rather than fall back to the shared network: a Session that quietly lands next to its
  // neighbours is the thing this is here to prevent, and the Card can explain a refusal.
  let network = env.workloadNetwork;
  if (env.perSessionNetwork) {
    try {
      network = await createSessionNetwork(docker, req.sessionId, req.boardSlug, env.workloadNetwork);
    } catch (err) {
      await removeSessionNetwork(docker, req.sessionId).catch(() => {});
      const message = (err as Error).message;
      console.error(`[runner] could not isolate session ${req.sessionId}: ${message}`);
      return c.json({ error: `could not create the session network: ${message}` }, 500);
    }
  }

  let created: Docker.Container | null = null;
  try {
    const container = await docker.createContainer({
      Image: image,
      name,
      Env: envList,
      Labels: {
        "com.centurylinklabs.watchtower.enable": "false",
        "kardboard.session": req.sessionId,
        "kardboard.board": req.boardSlug,
      },
      // The prompt is delivered on stdin so it stays out of `docker inspect`. The entrypoint then
      // hands it to the provider CLI as an argument, so it does show in the container's process list.
      OpenStdin: true,
      StdinOnce: true,
      HostConfig: {
        // The agent spawns shells, builds, and dev servers; an init as PID 1 reaps what they orphan.
        Init: true,
        Memory: env.memoryBytes,
        NanoCpus: env.nanoCpus,
        PidsLimit: env.pidsLimit,
        Binds: binds,
        NetworkMode: network,
        SecurityOpt: ["no-new-privileges:true"],
        CapDrop: ["ALL"],
        ReadonlyRootfs: false,
      },
    });
    created = container;
    const stdin = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
    await container.start();
    stdin.write(req.prompt);
    stdin.end();
    watchContainer(req.sessionId, container);
    console.log(`[runner] started ${name} (${image}) on ${network}`);
    return c.json({ containerId: container.id });
  } catch (err) {
    // A container that was created but never started would make the retry return it as if it were
    // running, so it goes, and the network that exists only for it goes with it.
    await created?.remove({ force: true }).catch(() => {});
    if (env.perSessionNetwork) await removeSessionNetwork(docker, req.sessionId).catch(() => {});
    throw err;
  }
});

app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const container = docker.getContainer(id);
  const info = await container.inspect().catch(() => null);
  // Only a Session container: the id names any container on the host, the stack's own included.
  const sessionId = info?.Config?.Labels?.["kardboard.session"];
  if (!info || !sessionId) return c.json({ ok: true, missing: true }, 404);
  await container.stop({ t: 10 }).catch(() => {});
  await container.remove({ force: true }).catch(() => {});
  // `watchContainer` also does this, but a runner that restarted mid-Session is no longer watching.
  await removeSessionNetwork(docker, sessionId).catch(() => {});
  return c.json({ ok: true });
});

// The container log is the Session's transcript. The app polls this with the offset it last saw
// and renders what comes back; the runner does no parsing.
app.get("/sessions/:id/log", (c) => {
  const offset = Number(c.req.query("offset") ?? "0");
  return c.json(readLogSlice(env.logDir, c.req.param("id"), Number.isFinite(offset) ? offset : 0));
});

app.get("/sessions", async (c) => {
  const list = await docker.listContainers({ all: true, filters: { label: ["kardboard.session"] } });
  return c.json(list.map((x) => ({ containerId: x.Id, sessionId: x.Labels["kardboard.session"], state: x.State, status: x.Status })));
});

const previewSchema = z.object({
  previewId: z.string().regex(ID_PATTERN),
  boardSlug: z.string(),
  cardId: z.string(),
  host: z.string(),
  repoUrl: z.string().url(),
  branch: z.string(),
  githubToken: z.string().nullable().default(null),
  dockerfile: z.string().default("Dockerfile"),
  port: z.number().int().positive().default(3000),
  env: z.record(z.string()).default({}),
});

const previewLimits = {
  routerNetwork: env.previewNetwork,
  memoryBytes: env.previewMemoryBytes,
  nanoCpus: env.previewNanoCpus,
  pidsLimit: env.previewPidsLimit,
  buildMemoryBytes: env.previewBuildMemoryBytes,
  buildTimeoutMs: env.previewBuildTimeoutMinutes * 60_000,
};

// A Preview network is removed with its Preview, but a first build the runner died during leaves
// one holding only the router. No build survives a runner restart, so they can all go now.
void prunePreviewNetworks(docker)
  .then((removed) => removed.length && console.log(`[runner] removed ${removed.length} orphaned preview network(s)`))
  .catch((err) => console.error("[runner] preview network prune failed", err));

async function reportPreview(previewId: string, body: { status: "running" | "failed"; containerId?: string; target?: string; error?: string }) {
  try {
    await fetch(`${env.appUrl}/api/internal/previews/${previewId}/state`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[runner] could not report preview ${previewId}`, err);
  }
}

// A build takes minutes, so the request only accepts the work. The app already knows the hostname,
// and the router serves a holding page until the runner reports the container is up.
app.post("/previews", async (c) => {
  const parsed = previewSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const req: PreviewRequest = parsed.data;
  const logPath = path.join(env.logDir, `preview-${req.previewId}.log`);
  fs.writeFileSync(logPath, `[preview] accepted ${req.host} at ${new Date().toISOString()}\n`);
  const onLog = (line: string) => fs.appendFileSync(logPath, `${line}\n`);

  void buildAndRunPreview(docker, req, previewLimits, onLog)
    .then(async ({ containerId, target }) => {
      await reportPreview(req.previewId, { status: "running", containerId, target });
    })
    .catch(async (err: Error) => {
      // A newer build or the Preview's removal replaced this one, and reports for itself.
      if (err instanceof PreviewCancelled) return console.log(`[runner] preview ${req.previewId} build stopped: ${err.message}`);
      const message = err instanceof PreviewError ? err.message : `preview failed: ${err.message}`;
      onLog(message);
      console.error(`[runner] preview ${req.previewId} failed`, message);
      await reportPreview(req.previewId, { status: "failed", error: message });
    });

  return c.json({ accepted: true }, 202);
});

app.delete("/previews/:id", async (c) => {
  const id = c.req.param("id");
  // The id becomes a file name below and a container, image, and network name inside.
  if (!ID_PATTERN.test(id)) return c.json({ error: "invalid preview id" }, 400);
  const removed = await removePreview(docker, id);
  fs.rmSync(path.join(env.logDir, `preview-${id}.log`), { force: true });
  return c.json({ ok: true, removed });
});

app.get("/previews", async (c) => {
  const list = await docker.listContainers({ all: true, filters: { label: ["kardboard.preview"] } });
  return c.json(list.map((x) => ({ containerId: x.Id, previewId: x.Labels["kardboard.preview"], host: x.Labels["kardboard.preview.host"], state: x.State, status: x.Status })));
});

app.get("/previews/:id/log", (c) => {
  const offset = Number(c.req.query("offset") ?? "0");
  return c.json(readLogSlice(env.logDir, `preview-${c.req.param("id")}`, Number.isFinite(offset) ? offset : 0));
});

function pruneLogs() {
  const cutoff = Date.now() - env.logRetentionDays * 86_400_000;
  for (const f of fs.readdirSync(env.logDir)) {
    const p = path.join(env.logDir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}
pruneLogs();
setInterval(pruneLogs, 6 * 3_600_000);
void reattachRunningSessions().catch((err) => console.error("[runner] re-attach failed", err));
void pruneExitedSessions()
  .then(() => pruneSessionNetworks(docker))
  .then((removed) => removed.length && console.log(`[runner] removed ${removed.length} orphaned session network(s)`))
  .catch((err) => console.error("[runner] prune failed", err));

serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`kardboard runner listening on :${info.port}`));
