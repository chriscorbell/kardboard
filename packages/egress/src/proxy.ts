import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { URL } from "node:url";
import type { CodexCredential } from "./codex-credential.js";
import { isAuthFailure, isUsageLimit, UsageLimits, type Provider } from "./limits.js";

// The request handling half of the egress proxy, kept apart from the process so a test can drive it
// against a local upstream. `index.ts` builds the config from the environment and listens.

export type ProxyConfig = {
  claudeToken: string;
  anthropicUpstream: URL;
  codexUpstream: URL;
  codex: Pick<CodexCredential, "headers"> | null;
  allowedNetworks: string[];
  /** Usage refusals seen on the way back from the providers. The app reads them from `/limits`. */
  limits?: UsageLimits;
  /** Guards `/limits`. Session containers reach this proxy too and have no reason to read it. */
  controlToken?: string;
  /** Stand-ins for the bounds below, which only a test sets. */
  maxConnections?: number;
  maxBodyBytes?: number;
  upstreamIdleMs?: number;
};

// Session containers are treated as hostile, so nothing they send may hold this process, or the
// provider connections it opens with the Admin's credential, without limit.
//
// At most four Sessions run at once, each with its subagents and a few calls in flight, so a few
// hundred connections is far more than they need.
export const MAX_CONNECTIONS = 256;
// A Claude request can carry a 1M-token context and images, which comes to tens of megabytes.
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
// A streamed turn can run for many minutes, but bytes keep arriving while it does. Ten minutes
// without one either way is a provider that has gone away.
export const UPSTREAM_IDLE_MS = 10 * 60_000;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

export function ipAllowed(ip: string | undefined, allowedNetworks: string[]): boolean {
  if (allowedNetworks.length === 0) return true;
  if (!ip) return false;
  const plain = ip.replace(/^::ffff:/, "");
  return allowedNetworks.some((cidr) => {
    const [base, bitsStr] = cidr.split("/");
    const bits = Number(bitsStr ?? "32");
    const toInt = (a: string) => a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(plain) & mask) === (toInt(base!) & mask);
  });
}

/** Everything the client sent that is ours to pass on: hop-by-hop headers and credentials are not. */
export function passThroughHeaders(incoming: http.IncomingHttpHeaders, drop: string[]): Record<string, string> {
  const dropped = new Set(drop);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (HOP_BY_HOP.has(k) || dropped.has(k)) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }
  return headers;
}

/** The Anthropic credential rewrite: drop whatever the Session sent, add the real token and the beta. */
export function anthropicHeaders(incoming: http.IncomingHttpHeaders, upstream: URL, claudeToken: string): Record<string, string> {
  const headers = passThroughHeaders(incoming, ["x-api-key", "authorization"]);
  headers["host"] = upstream.host;
  headers["authorization"] = `Bearer ${claudeToken}`;
  const beta = new Set((headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  beta.add("oauth-2025-04-20");
  headers["anthropic-beta"] = [...beta].join(",");
  return headers;
}

export type AllowedCall = {
  method: string;
  path: RegExp;
  /**
   * Runs a turn. Only the answer to one of these says anything about the subscription: a model lookup
   * or a token count the provider declines or throttles for its own reasons is neither a rejected
   * sign-in nor a spent usage window, and every Session makes a turn call within seconds of starting,
   * so nothing real is missed by looking only here.
   */
  turn?: true;
};

/**
 * The calls a Session may make on each route, by method and path after the route prefix. The token
 * attached here is the Admin's own subscription, which also reads and changes the account behind it:
 * ChatGPT conversations and profile, Anthropic organisation settings and usage. So only what Claude
 * Code and Codex send to run a turn goes upstream. Observed on 2026-09-24 in Claude Code 2.1 with a
 * custom base URL, which sends inference, token counts, model lookups, and a fire-and-forget
 * `HEAD /api/hello`, and in codex-cli's `codex-api` crate, whose named provider sends `responses`,
 * `models`, and `memories/trace_summarize` under its base URL. A refusal is logged with its path, so
 * a new call after a CLI upgrade shows up in the egress log rather than as a mystery.
 */
export const ALLOWED_CALLS: Record<Provider, AllowedCall[]> = {
  claude: [
    { method: "POST", path: /^\/v1\/messages$/, turn: true },
    { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
    { method: "GET", path: /^\/v1\/models(\/[A-Za-z0-9._-]+)?$/ },
    { method: "HEAD", path: /^\/api\/hello$/ },
  ],
  codex: [
    { method: "POST", path: /^\/responses(\/compact)?$/, turn: true },
    { method: "GET", path: /^\/models$/ },
    { method: "POST", path: /^\/memories\/trace_summarize$/ },
  ],
};

/**
 * A dot segment, or a percent-encoded dot, slash, or backslash, anywhere in the path. The upstream
 * or anything in front of it may normalise `/openai/%2e%2e/%2e%2e/me` into a path outside the route,
 * so these are refused before the allowlist is consulted, not left to it.
 */
export function escapesRoute(path: string): boolean {
  return /%2e|%2f|%5c|\\/i.test(path) || path.split("/").some((segment) => segment === "." || segment === "..");
}

/** The entry on the allowlist that a call matches, or undefined when a Session may not make it. */
export function allowedCall(provider: Provider, method: string | undefined, targetPath: string): AllowedCall | undefined {
  const path = targetPath.split("?")[0]!;
  if (escapesRoute(path)) return undefined;
  return ALLOWED_CALLS[provider].find((call) => call.method === method && call.path.test(path));
}

export function callAllowed(provider: Provider, method: string | undefined, targetPath: string): boolean {
  return allowedCall(provider, method, targetPath) !== undefined;
}

/**
 * Whether a request carries the control token. Both sides are hashed first so the comparison takes
 * the same time however much of a guess is right, and so their lengths always match, as
 * `timingSafeEqual` needs. An empty expected token matches nothing.
 */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!token) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization ?? ""), digest(`Bearer ${token}`));
}

/** Passes a request body on until it grows past `maxBytes`, then fails rather than pass on more. */
function capped(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(new Error(`request body over ${maxBytes} bytes`));
      else done(null, chunk);
    },
  });
}

/**
 * The proxy as a server, with its connection limit. Past the limit Node closes a new connection as
 * soon as it is accepted, which bounds what a Session opening connections without end costs this
 * process, though not what it costs the other Sessions until it is stopped.
 */
export function createServer(config: ProxyConfig): http.Server {
  const server = http.createServer(createProxy(config));
  server.maxConnections = config.maxConnections ?? MAX_CONNECTIONS;
  return server;
}

/** Join the upstream's own base path with the path left after the route prefix is removed. */
export function upstreamPath(upstream: URL, targetPath: string): string {
  return `${upstream.pathname.replace(/\/$/, "")}${targetPath}`;
}

export function createProxy(config: ProxyConfig): http.RequestListener {
  const limits = config.limits ?? new UsageLimits();
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;
  const upstreamIdleMs = config.upstreamIdleMs ?? UPSTREAM_IDLE_MS;
  const credentials = () => ({ claude: config.claudeToken !== "", codex: config.codex !== null });
  // A test points an upstream at a local http server; production upstreams are https.
  const request = (options: https.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
    options.protocol === "http:" ? http.request(options, cb) : https.request(options, cb);

  // The connection is closed after the answer, so the rest of an oversized body is never read.
  function tooLarge(res: http.ServerResponse) {
    console.warn(`[egress] refused a request body over ${maxBodyBytes} bytes`);
    if (res.headersSent) return void res.destroy();
    res.writeHead(413, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: "request_too_large" }));
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse, provider: Provider, turn: boolean, upstream: URL, targetPath: string, headers: Record<string, string>) {
    // A body that says up front it is too large is refused before anything goes upstream.
    if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) return tooLarge(res);
    const proxied = request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "http:" ? 80 : 443),
        path: upstreamPath(upstream, targetPath),
        method: req.method,
        headers,
        timeout: upstreamIdleMs,
      },
      (up) => {
        // Only a turn's answer speaks for the subscription (see `AllowedCall`). A recorded refusal
        // stops the app starting Sessions on this Provider, on every Board, until the window it
        // names reopens, so a throttled token count or model lookup, which a Session can make as
        // often as it likes, must not be taken for one.
        if (turn) {
          const status = up.statusCode ?? 0;
          if (isUsageLimit(status)) {
            // The refusal still reaches the Session, which may retry through it.
            const limit = limits.note(provider, up.headers);
            console.warn(`[egress] ${provider} refused a request for want of usage; window reopens ${limit.until ?? "at an unstated time"}`);
          } else if (isAuthFailure(status)) {
            // A rejected credential fails every Session on this Provider until the Admin replaces
            // it, and nothing but this proxy sees the provider's answer, so it is kept for the app.
            limits.noteAuthFailure(provider, status, `${req.method} ${targetPath.split("?")[0]} answered ${status}`);
            console.warn(`[egress] ${provider} rejected the credential with ${status}`);
          } else if (status >= 200 && status < 300) {
            limits.noteAccepted(provider);
          }
        }
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) outHeaders[k] = v;
        res.writeHead(up.statusCode ?? 502, outHeaders);
        up.pipe(res);
      },
    );
    // The idle timer counts bytes either way, so a long turn that streams keeps it from firing.
    proxied.on("timeout", () => {
      console.error(`[egress] ${provider} sent nothing for ${upstreamIdleMs / 1000} seconds; cutting the call`);
      if (!res.headersSent) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream_timeout" }));
      } else {
        res.destroy();
      }
      proxied.destroy();
    });
    proxied.on("error", (err: Error) => {
      // Ending the call raised this: a refusal or a timeout has already answered, or the Session left.
      if (res.writableEnded || res.destroyed) return;
      console.error("[egress] upstream error", err.message);
      // Once a response has begun, cutting it is the only way left to tell the Session it failed.
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unreachable" }));
    });
    // A Session that hangs up mid-call leaves the provider's answer nowhere to go.
    res.on("close", () => {
      if (!res.writableFinished) proxied.destroy();
    });
    // A body sent without a length, or with a false one, is counted as it streams through.
    const body = capped(maxBodyBytes);
    body.on("error", () => {
      tooLarge(res);
      proxied.destroy();
    });
    req.pipe(body).pipe(proxied);
  }

  function refuse(req: http.IncomingMessage, res: http.ServerResponse, provider: Provider, targetPath: string) {
    const path = targetPath.split("?")[0]!.slice(0, 200);
    // Counted for the app as well as logged: after a CLI upgrade this is the first sign that a
    // Provider calls something new, and the log alone goes unread.
    limits.noteRefused(provider, req.method ?? "", path);
    console.warn(`[egress] refused ${provider} ${req.method} ${JSON.stringify(path)}: not a call a Session needs`);
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "call_not_allowed" }));
  }

  return (req, res) => {
    // Which credentials this process holds, as booleans only: the check answers anything that can
    // reach the proxy, Session containers included.
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, credentials: credentials() }));
      return;
    }
    if (!ipAllowed(req.socket.remoteAddress, config.allowedNetworks)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    // What the app needs to decide whether to fall a Card's Session back to the other Provider, and
    // what the Admin panel shows about each one. It never carries a credential: only whether one is
    // loaded and whether the provider last rejected it.
    if (req.url === "/limits") {
      req.resume();
      if (config.controlToken && !bearerMatches(req.headers["authorization"], config.controlToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...limits.report(), credentials: credentials() }));
      return;
    }

    if (req.url?.startsWith("/anthropic/")) {
      const targetPath = req.url.slice("/anthropic".length);
      const call = allowedCall("claude", req.method, targetPath);
      if (!call) return refuse(req, res, "claude", targetPath);
      forward(req, res, "claude", call.turn === true, config.anthropicUpstream, targetPath, anthropicHeaders(req.headers, config.anthropicUpstream, config.claudeToken));
      return;
    }

    if (req.url?.startsWith("/openai/")) {
      const targetPath = req.url.slice("/openai".length);
      const call = allowedCall("codex", req.method, targetPath);
      if (!call) return refuse(req, res, "codex", targetPath);
      const codex = config.codex;
      if (!codex) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "codex_credential_unavailable" }));
        req.resume();
        return;
      }
      // Whatever the Session sent as its own identity is dropped; only this proxy's copy is used.
      const headers = passThroughHeaders(req.headers, ["authorization", "chatgpt-account-id"]);
      headers["host"] = config.codexUpstream.host;
      void codex
        .headers()
        .then(
          ({ authorization, accountId }) => {
            headers["authorization"] = authorization;
            if (accountId) headers["chatgpt-account-id"] = accountId;
            forward(req, res, "codex", call.turn === true, config.codexUpstream, targetPath, headers);
          },
          (err: Error) => {
            // The message can carry a fragment of the token endpoint's answer, so only its status
            // travels on to the app.
            const status = /refresh failed: (\d{3})/.exec(err.message)?.[1];
            limits.noteAuthFailure("codex", status ? Number(status) : null, "the sign-in file could not be read or refreshed");
            throw err;
          },
        )
        .catch((err: Error) => {
          console.error("[egress] codex credential error", err.message);
          // The body is deliberately vague: a Session must not learn about the credential's state.
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "codex_credential_unavailable" }));
          req.resume();
        });
      return;
    }

    res.writeHead(404);
    res.end("unknown upstream");
  };
}
