import http from "node:http";
import { COOKIE_NAME, cookieHeader, forwardHeaders, holdingPage, readCookie, safeNext, signInRedirect, verifyCookie, type Route } from "./preview.js";

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

async function exchange(code: string, host: string): Promise<{ cookie: string; maxAgeSeconds: number } | { error: string }> {
  const res = await fetch(`${appUrl}/api/internal/previews/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code, host }),
  });
  if (!res.ok) return (await res.json().catch(() => ({ error: "the app refused that sign-in link" }))) as { error: string };
  return (await res.json()) as { cookie: string; maxAgeSeconds: number };
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
  const route = routes.get(host);
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No preview at this address.");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${host}`);

  // Step two of the sign-in redirect: spend the code, set a host-only cookie, carry on.
  if (url.pathname === "/__kardboard/auth") {
    const code = url.searchParams.get("code") ?? "";
    const next = safeNext(url.searchParams.get("next"));
    void exchange(code, host).then((result) => {
      if ("error" in result) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(result.error);
        return;
      }
      res.writeHead(302, { "set-cookie": cookieHeader(result.cookie, result.maxAgeSeconds, secureCookies), location: next });
      res.end();
    });
    return;
  }

  if (!verifyCookie(readCookie(req.headers.cookie, COOKIE_NAME), host, route, secret)) {
    res.writeHead(302, { location: signInRedirect(publicAppUrl, host, req.url ?? "/") });
    res.end();
    return;
  }

  if (route.status !== "running" || !route.target) {
    const { status, body } = holdingPage(route, host);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }

  const target = new URL(route.target);
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: forwardHeaders(req.headers, target.host) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Preview is not responding.");
  });
  req.pipe(upstream);
});

void refreshRoutes();
setInterval(() => void refreshRoutes(), 15_000);
server.listen(port, () => console.log(`kardboard preview-router listening on :${port}`));
