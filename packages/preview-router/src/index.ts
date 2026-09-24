import http from "node:http";
import type { Route } from "./preview.js";
import { createRouter, type ExchangeResult } from "./router.js";

// Routes configured preview hostnames to containers and gates access with a signed,
// host-only cookie.
//
// A visitor with no cookie is sent to the app, which knows who they are and whether they are a
// Member of the Preview's Board. The app sends them back here with a single-use code; this router
// spends the code over the internal network and sets the cookie. Branch-controlled code never sees
// a kardboard credential: every cookie and Authorization header is stripped before proxying.

const port = Number(process.env.PORT ?? "3072");
const secret = process.env.KARDBOARD_PREVIEW_SECRET ?? "";
const appUrl = (process.env.KARDBOARD_APP_URL ?? "http://app:3070").replace(/\/$/, "");
const publicAppUrl = (process.env.KARDBOARD_PUBLIC_URL ?? "https://kardboard.cc").replace(/\/$/, "");
const runnerToken = process.env.KARDBOARD_RUNNER_TOKEN ?? "";
const secureCookies = !/^(0|false|no)$/i.test(process.env.KARDBOARD_PREVIEW_SECURE_COOKIES ?? "1");

const routes = new Map<string, Route>();

async function refreshRoutes() {
  try {
    const res = await fetch(`${appUrl}/api/internal/previews`, { headers: { Authorization: `Bearer ${runnerToken}` } });
    if (!res.ok) return;
    const list = (await res.json()) as Route[];
    routes.clear();
    for (const r of list) routes.set(r.host, r);
  } catch {
    // keep the last known table
  }
}

async function exchange(code: string, host: string): Promise<ExchangeResult> {
  const res = await fetch(`${appUrl}/api/internal/previews/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code, host }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { error: typeof body.error === "string" ? body.error : "the app refused that sign-in link" };
  }
  return (await res.json()) as { cookie: string; maxAgeSeconds: number };
}

const server = http.createServer(createRouter({ route: (host) => routes.get(host), exchange, secret, publicAppUrl, secureCookies }));

void refreshRoutes();
setInterval(() => void refreshRoutes(), 15_000);
server.listen(port, () => console.log(`kardboard preview-router listening on :${port}`));
