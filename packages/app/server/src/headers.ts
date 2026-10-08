import type { Context, MiddlewareHandler } from "hono";
import crypto from "node:crypto";

/**
 * Headers every response carries. The app is never framed, by anyone, so no page can steer a
 * click in it. A route that already chose one of these headers keeps its own: the attachment
 * route's sandbox policy is stricter than this one.
 *
 * kardboard is served over plain http, so it asks for no HSTS. It withdraws the one it once asked for:
 * on 2026-10-07 it ran behind Tailscale Serve at `https://minicore.saanen-monitor.ts.net` and sent a
 * year of HSTS with `includeSubDomains`, which makes a browser that saw it refuse plain http to every
 * port on minicore, the other apps there included. `max-age=0` over https makes such a browser forget
 * it, and over http a browser ignores the header.
 */
export function securityHeaders(): MiddlewareHandler {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    "Strict-Transport-Security": "max-age=0",
  };
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}

// Only scripts the shell itself names may run, and whatever those load, which `'strict-dynamic'`
// allows; anything else, an uploaded file opened from a blob URL on this origin among them, runs no
// script. The page sets its own policy, so it repeats the framing rule every other response gets from
// `securityHeaders`. Enforced since 2026-10-01; Clerk's scripts, which it once had to make room for,
// went on 2026-10-07.
export function shellPolicy(nonce: string): string {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

/**
 * The page every client route is served from, with a fresh nonce on every script tag in it and in the
 * page's policy for each request.
 */
export function appShell(template: string): (c: Context) => Response {
  return (c) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = template.replace(/<script\b/g, `<script nonce="${nonce}"`);
    c.header("Content-Security-Policy", shellPolicy(nonce));
    return c.html(html);
  };
}
