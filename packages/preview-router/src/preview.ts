import { createHmac, timingSafeEqual } from "node:crypto";

// The routing and cookie rules, kept apart from the server so they can be tested without a socket.

export interface Route {
  host: string;
  target: string | null;
  status: "building" | "running" | "failed";
  error: string | null;
  // The Board's current preview epoch. A cookie issued before the Board's membership last narrowed
  // carries a lower number and stops working, which is how revoking membership revokes access.
  epoch: number;
}

export interface PreviewCookie {
  host: string;
  board: string;
  user: string;
  epoch: number;
  exp: number;
}

export const COOKIE_NAME = "kardboard_preview";

// Every value sent under that name, not just the first. Code on one Preview can set a cookie of the
// same name for the whole parent domain, from a response or from JavaScript, and the browser then
// sends it to every other Preview beside, or ahead of, the real one. A caller tries each in turn.
export function readCookies(header: string | undefined, name = COOKIE_NAME): string[] {
  return (header ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${name}=`))
    .map((s) => s.slice(name.length + 1));
}

export function verifyCookie(value: string | undefined, host: string, route: Route, secret: string, nowMs = Date.now()): boolean {
  if (!value || !secret) return false;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewCookie;
    return data.host === host && data.epoch >= route.epoch && data.exp > nowMs / 1000;
  } catch {
    return false;
  }
}

// Everything kardboard puts on the wire is removed before branch-controlled code sees the request:
// the Preview cookie itself, any other cookie that reached this host, and any Authorization header.
export type Headers = Record<string, string | string[] | undefined>;

export function forwardHeaders(headers: Headers, targetHost: string): Headers {
  const out: Headers = { ...headers, host: targetHost };
  delete out.cookie;
  delete out.authorization;
  delete out["proxy-authorization"];
  return out;
}

// A Preview may set cookies for its own host, but not for the parent domain, where every other
// Preview would receive them, and never one carrying the router's own cookie name.
export function responseHeaders(headers: Headers): Headers {
  const out: Headers = { ...headers };
  const cookies = headers["set-cookie"];
  if (!cookies) return out;
  const kept = (Array.isArray(cookies) ? cookies : [cookies])
    .filter((cookie) => !cookie.split(";")[0]!.includes(COOKIE_NAME))
    .map((cookie) => cookie.split(";").filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part)).join(";"));
  if (kept.length > 0) out["set-cookie"] = kept;
  else delete out["set-cookie"];
  return out;
}

// `next` comes back from the app's redirect, so it is only ever a path on this host. Browsers read
// `\` as `/` and drop tabs and newlines inside a URL, which turns `/\evil.com` and `/<TAB>/evil.com`
// into `//evil.com`, and a line break would also split the Location header. So only printable
// ASCII without a backslash is accepted, and it must still resolve to this Preview's own origin.
export function safeNext(next: string | null, host: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || !/^[\x21-\x7e]*$/.test(next) || next.includes("\\")) return "/";
  const origin = `https://${host}`;
  try {
    return new URL(next, origin).origin === origin ? next : "/";
  } catch {
    return "/";
  }
}

export function signInRedirect(publicAppUrl: string, host: string, url: string): string {
  return `${publicAppUrl}/preview-auth?host=${encodeURIComponent(host)}&next=${encodeURIComponent(url)}`;
}

export function holdingPage(route: Route, host: string): { status: number; body: string } {
  if (route.status === "building") {
    return {
      status: 503,
      body: page("Building this preview", `kardboard is building <code>${escapeHtml(host)}</code> from its branch. This page refreshes every ten seconds.`, true),
    };
  }
  return {
    status: 502,
    body: page("This preview could not be built", escapeHtml(route.error ?? "The build failed and the runner did not say why."), false),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function page(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${refresh ? '<meta http-equiv="refresh" content="10">' : ""}<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:38rem;padding:0 1.5rem;color:#1c1917}h1{font-size:1.2rem}code{background:#f5f5f4;padding:.1rem .3rem;border-radius:.25rem}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

// Host-only: no Domain attribute, so the browser sends it to this one preview host and nowhere else.
export function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
