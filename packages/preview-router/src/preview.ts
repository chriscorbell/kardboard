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

// Cloudflare tells the origin who is visiting: the Member's address, their country, and ids that
// tie the request to them in Cloudflare's logs. Branch-controlled code has no use for any of it,
// so it goes too. X-Forwarded-Proto stays, so a Preview can still tell it was reached over HTTPS.
const VISITOR_HEADERS = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
  "cf-ipcountry",
  "cf-visitor",
  "cf-ray",
  "cf-worker",
  "cdn-loop",
];

export function forwardHeaders(headers: Headers, targetHost: string): Headers {
  const out: Headers = { ...headers, host: targetHost };
  delete out.cookie;
  delete out.authorization;
  delete out["proxy-authorization"];
  for (const name of VISITOR_HEADERS) delete out[name];
  return out;
}

// Cloudflare stores responses for paths that look static, `.js`, `.css`, images and the like, by
// default and without regard to cookies, then serves the stored copy to whoever asks next without
// reaching this router. A Member's request could leave a Preview's code at the edge for a stranger
// to read, and a stranger's could leave the sign-in redirect there for every Member. So nothing
// the router sends may be stored at the edge. Cloudflare obeys Cloudflare-CDN-Cache-Control ahead
// of Cache-Control and keeps it to itself; CDN-Cache-Control says the same to any other CDN on
// the way, and browsers ignore both.
export const EDGE_NO_STORE = { "cloudflare-cdn-cache-control": "no-store", "cdn-cache-control": "no-store" };

// The router's own answers, the redirects, holding page and errors, are not kept by browsers either.
export const NO_STORE = { ...EDGE_NO_STORE, "cache-control": "no-store" };

// A Preview's Cache-Control still reaches the browser, which may keep what it was told to, but
// `public` invites any shared cache along the way to keep it too, so it becomes `private`.
function privateCacheControl(value: string): string {
  const directives = value.split(",").map((d) => d.trim()).filter(Boolean);
  if (!directives.some((d) => d.toLowerCase() === "public")) return value;
  return ["private", ...directives.filter((d) => !/^(public|private)$/i.test(d))].join(", ");
}

// A Preview may set cookies for its own host, but not for the parent domain, where every other
// Preview would receive them, and never one carrying the router's own cookie name. Nor may it
// ask the edge to store it: its own CDN cache headers are replaced with the router's.
export function responseHeaders(headers: Headers): Headers {
  const out: Headers = { ...headers, ...EDGE_NO_STORE };
  const cacheControl = headers["cache-control"];
  if (typeof cacheControl === "string") out["cache-control"] = privateCacheControl(cacheControl);
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
