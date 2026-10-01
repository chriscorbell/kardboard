import type { Context, MiddlewareHandler } from "hono";
import crypto from "node:crypto";

/**
 * Headers every response carries. A Preview runs branch-controlled code on a host of the app's own
 * site, so it could otherwise frame the app, where Clerk's Lax cookies still arrive and the Member is
 * signed in, and steer their click onto Approve. The app is never framed, by anyone. A route that
 * already chose one of these headers keeps its own: the attachment route's sandbox policy is
 * stricter than this one.
 *
 * HSTS is sent only from a production app behind https. A browser that has seen it refuses plain
 * http to the host, and to every Preview under it, for a year, which a local or http deployment must
 * not ask for. It is not `preload`: that list is slow to leave, and joining it is a decision about the
 * domain rather than about this app.
 */
export function securityHeaders(input: { production: boolean; publicUrl: string }): MiddlewareHandler {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  };
  if (input.production && input.publicUrl.startsWith("https://")) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}

// Only scripts the shell itself names may run, and whatever those load: clerk-js, its UI, and the
// Cloudflare challenge it may add are all inserted by a trusted script, which `'strict-dynamic'`
// allows wherever they come from. `https:` is Clerk's fallback for a browser too old to know
// `'strict-dynamic'`; one that knows it ignores host sources. Anything else, an uploaded file opened
// from a blob URL on this origin among them, runs no script. The page sets its own policy, so it
// repeats the framing rule every other response gets from `securityHeaders`.
//
// Enforced since 2026-10-01, after the policy ran report-only on kardboard.cc with Clerk's sign-in
// loaded, and on every signed-in page of a production build, without a single violation.
export function shellPolicy(nonce: string): string {
  return `script-src 'nonce-${nonce}' 'strict-dynamic' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

/**
 * The page every client route is served from. Runtime config is injected into it so one image serves
 * every environment, and each request gets a fresh nonce: on every script tag in the page, in the
 * config for the Clerk provider to put on the scripts it loads, and in the page's policy.
 */
export function appShell(template: string, config: Record<string, unknown>): (c: Context) => Response {
  return (c) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = template
      .replace("<!--kardboard-config-->", `<script>window.__KARDBOARD_CONFIG__=${JSON.stringify({ ...config, nonce })}</script>`)
      .replace(/<script\b/g, `<script nonce="${nonce}"`);
    c.header("Content-Security-Policy", shellPolicy(nonce));
    return c.html(html);
  };
}
