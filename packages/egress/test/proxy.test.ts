import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { URL } from "node:url";
import { UsageLimits } from "../src/limits.js";
import {
  allowedCall,
  anthropicHeaders,
  bearerMatches,
  callAllowed,
  createProxy,
  createServer,
  escapesRoute,
  ipAllowed,
  MAX_CONNECTIONS,
  passThroughHeaders,
  upstreamPath,
} from "../src/proxy.js";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** Stands in for the provider: records what arrived and answers with something recognisable. */
function upstreamServer(seen: Seen[]): Promise<{ url: URL; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: new URL(`http://127.0.0.1:${port}/backend-api/codex`),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function proxyServer(listener: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("which callers are allowed", () => {
  it("allows everything when no networks are configured", () => {
    assert.equal(ipAllowed(undefined, []), true);
    assert.equal(ipAllowed("10.9.9.9", []), true);
  });

  it("matches inside the configured network and rejects outside it", () => {
    assert.equal(ipAllowed("172.20.0.5", ["172.20.0.0/16"]), true);
    assert.equal(ipAllowed("::ffff:172.20.0.5", ["172.20.0.0/16"]), true);
    assert.equal(ipAllowed("10.0.0.5", ["172.20.0.0/16"]), false);
    assert.equal(ipAllowed(undefined, ["172.20.0.0/16"]), false);
  });
});

describe("rewriting headers", () => {
  it("drops hop-by-hop headers and the ones it is told to", () => {
    const headers = passThroughHeaders({ connection: "keep-alive", host: "proxy", "content-length": "3", authorization: "Bearer session", accept: "*/*" }, ["authorization"]);
    assert.deepEqual(headers, { accept: "*/*" });
  });

  it("joins a header the client repeated", () => {
    assert.equal(passThroughHeaders({ "x-thing": ["a", "b"] }, [])["x-thing"], "a, b");
  });

  it("replaces the Session's Anthropic credential with the real one", () => {
    const headers = anthropicHeaders({ "x-api-key": "kardboard-egress", authorization: "Bearer fake" }, new URL("https://api.anthropic.com"), "real-token");
    assert.equal(headers["authorization"], "Bearer real-token");
    assert.equal(headers["x-api-key"], undefined);
    assert.equal(headers["host"], "api.anthropic.com");
  });

  it("adds the oauth beta without discarding the betas the client asked for", () => {
    const headers = anthropicHeaders({ "anthropic-beta": "context-1m-2025-08-07" }, new URL("https://api.anthropic.com"), "t");
    assert.deepEqual(headers["anthropic-beta"]?.split(","), ["context-1m-2025-08-07", "oauth-2025-04-20"]);
  });

  it("does not repeat the oauth beta when the client already sent it", () => {
    assert.equal(anthropicHeaders({ "anthropic-beta": "oauth-2025-04-20" }, new URL("https://api.anthropic.com"), "t")["anthropic-beta"], "oauth-2025-04-20");
  });

  it("keeps the upstream's own base path in front of the request path", () => {
    assert.equal(upstreamPath(new URL("https://chatgpt.com/backend-api/codex"), "/responses"), "/backend-api/codex/responses");
    assert.equal(upstreamPath(new URL("https://api.anthropic.com"), "/v1/messages"), "/v1/messages");
  });
});

describe("proxying a Codex request", () => {
  const seen: Seen[] = [];
  let upstream: Awaited<ReturnType<typeof upstreamServer>>;
  let proxy: Awaited<ReturnType<typeof proxyServer>>;

  before(async () => {
    upstream = await upstreamServer(seen);
    proxy = await proxyServer(
      createProxy({
        claudeToken: "claude-token",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: { headers: async () => ({ authorization: "Bearer real-codex-token", accountId: "acct-real" }) },
        allowedNetworks: [],
      }),
    );
  });
  after(async () => {
    await proxy.close();
    await upstream.close();
  });

  it("injects the credential the Session does not have and forwards the body", async () => {
    const res = await fetch(`${proxy.base}/openai/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", originator: "codex_exec", authorization: "Bearer placeholder", "chatgpt-account-id": "acct-placeholder" },
      body: JSON.stringify({ model: "gpt-6" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-upstream"), "yes");

    const got = seen.at(-1)!;
    assert.equal(got.url, "/backend-api/codex/responses", "the route prefix is swapped for the upstream's base path");
    assert.equal(got.headers.authorization, "Bearer real-codex-token");
    assert.equal(got.headers["chatgpt-account-id"], "acct-real", "the Session's own account id is not trusted");
    assert.equal(got.headers.originator, "codex_exec", "headers Codex needs are passed through");
    assert.equal(got.body, JSON.stringify({ model: "gpt-6" }));
  });

  it("leaves the account id off when the sign-in file names none", async () => {
    const bare = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: { headers: async () => ({ authorization: "Bearer real", accountId: null }) },
        allowedNetworks: [],
      }),
    );
    await fetch(`${bare.base}/openai/responses`, { method: "POST", body: "{}" });
    assert.equal(seen.at(-1)!.headers["chatgpt-account-id"], undefined);
    await bare.close();
  });
});

describe("a proxy with no Codex credential", () => {
  it("refuses the route instead of forwarding an unauthenticated request", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [] }),
    );
    const res = await fetch(`${proxy.base}/openai/responses`, { method: "POST", body: "{}" });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "codex_credential_unavailable" });
    assert.equal(seen.length, 0);

    const health = await fetch(`${proxy.base}/healthz`);
    assert.deepEqual(await health.json(), { ok: true, credentials: { claude: true, codex: false } });

    await proxy.close();
    await upstream.close();
  });

  it("tells the Session nothing about why the credential failed", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: {
          headers: async () => {
            throw new Error("refresh token rejected for account acct-real");
          },
        },
        allowedNetworks: [],
      }),
    );
    const res = await fetch(`${proxy.base}/openai/responses`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "codex_credential_unavailable" });
    assert.equal(seen.length, 0);
    await proxy.close();
    await upstream.close();
  });
});

/** A request sent exactly as written: `fetch` would resolve `..` and `%2e%2e` before sending. */
function raw(base: string, method: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, method, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("what a Session may ask a provider for", () => {
  it("lets through the calls Claude Code makes to run a turn", () => {
    assert.equal(callAllowed("claude", "POST", "/v1/messages?beta=true"), true);
    assert.equal(callAllowed("claude", "POST", "/v1/messages/count_tokens?beta=true"), true);
    assert.equal(callAllowed("claude", "GET", "/v1/models"), true);
    assert.equal(callAllowed("claude", "GET", "/v1/models/claude-opus-4-1"), true);
    assert.equal(callAllowed("claude", "HEAD", "/api/hello"), true);
  });

  it("lets through the calls Codex makes to run a turn", () => {
    assert.equal(callAllowed("codex", "POST", "/responses"), true);
    assert.equal(callAllowed("codex", "POST", "/responses/compact"), true);
    assert.equal(callAllowed("codex", "GET", "/models?client_version=0.154.0"), true);
  });

  it("refuses the rest of what the Admin's credential could reach", () => {
    assert.equal(callAllowed("claude", "GET", "/api/oauth/usage"), false);
    assert.equal(callAllowed("claude", "POST", "/v1/files"), false);
    assert.equal(callAllowed("claude", "GET", "/v1/messages"), false, "the right path with the wrong method");
    assert.equal(callAllowed("codex", "GET", "/wham/usage"), false);
    assert.equal(callAllowed("codex", "DELETE", "/responses"), false);
  });

  it("refuses a path that climbs out of the route, however it is spelled", () => {
    for (const path of ["/../../conversations", "/%2e%2e/%2e%2e/me", "/responses/../../me", "/responses/%2E%2E", "/responses%2f..%2fme", "/responses/.", "/responses\\..\\me"]) {
      assert.equal(escapesRoute(path), true, path);
      assert.equal(callAllowed("codex", "POST", path), false, path);
    }
    assert.equal(callAllowed("claude", "GET", "/v1/models/.."), false);
  });

  it("answers 403 and sends nothing upstream for a call off the list", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: { headers: async () => ({ authorization: "Bearer real", accountId: null }) },
        allowedNetworks: [],
      }),
    );
    for (const [method, path] of [
      ["GET", "/openai/../../conversations"],
      ["GET", "/openai/%2e%2e/%2e%2e/me"],
      ["GET", "/anthropic/api/oauth/usage"],
      ["POST", "/anthropic/v1/messages/../../api/oauth/profile"],
    ] as const) {
      const res = await raw(proxy.base, method, path);
      assert.equal(res.status, 403, path);
      assert.deepEqual(JSON.parse(res.body), { error: "call_not_allowed" });
    }
    assert.equal(seen.length, 0, "the credential never left the proxy");
    await proxy.close();
    await upstream.close();
  });
});

describe("routes that are not a provider", () => {
  it("answers 404 rather than forwarding somewhere unexpected", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [] }),
    );
    for (const path of ["/", "/openai", "/anthropic", "/elsewhere/v1"]) {
      assert.equal((await fetch(`${proxy.base}${path}`)).status, 404, path);
    }
    assert.equal(seen.length, 0);
    await proxy.close();
    await upstream.close();
  });
});

/** Stands in for a provider that has no usage left. */
function refusingUpstream(headers: Record<string, string>): Promise<{ url: URL; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ error: { type: "rate_limit_error" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: new URL(`http://127.0.0.1:${port}`), close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("noticing that a provider is out of usage", () => {
  it("records the refusal and still hands it to the Session", async () => {
    const upstream = await refusingUpstream({ "retry-after": "1800" });
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [], limits }),
    );

    const res = await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 429, "the Session sees the provider's own answer, unchanged");
    assert.deepEqual(await res.json(), { error: { type: "rate_limit_error" } });

    const seen = limits.snapshot();
    assert.equal(seen.codex, null, "a Claude refusal says nothing about Codex");
    assert.ok(seen.claude, "the Claude refusal was recorded");
    const until = Date.parse(seen.claude.until!);
    assert.ok(until > Date.now() + 1_700_000 && until <= Date.now() + 1_800_000, `window reopens in about half an hour, got ${seen.claude.until}`);

    await proxy.close();
    await upstream.close();
  });

  it("attributes a refusal on the Codex route to Codex", async () => {
    const upstream = await refusingUpstream({});
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: { headers: async () => ({ authorization: "Bearer real", accountId: null }) },
        allowedNetworks: [],
        limits,
      }),
    );

    assert.equal((await fetch(`${proxy.base}/openai/responses`, { method: "POST", body: "{}" })).status, 429);
    const seen = limits.snapshot();
    assert.equal(seen.claude, null);
    assert.equal(seen.codex?.until, null, "this provider named no window");
    assert.ok(seen.codex?.at);

    await proxy.close();
    await upstream.close();
  });

  it("counts only the calls that run a turn", () => {
    assert.equal(allowedCall("claude", "POST", "/v1/messages?beta=true")?.turn, true);
    assert.equal(allowedCall("codex", "POST", "/responses")?.turn, true);
    assert.equal(allowedCall("codex", "POST", "/responses/compact")?.turn, true);
    for (const [provider, method, path] of [
      ["claude", "POST", "/v1/messages/count_tokens"],
      ["claude", "GET", "/v1/models"],
      ["claude", "HEAD", "/api/hello"],
      ["codex", "GET", "/models"],
      ["codex", "POST", "/memories/trace_summarize"],
    ] as const) {
      assert.ok(allowedCall(provider, method, path), `${path} is still allowed`);
      assert.equal(allowedCall(provider, method, path)?.turn, undefined, path);
    }
  });

  it("ignores a 429 on a call that does not run a turn, whatever window it names", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 20 * 3600);
    const upstream = await refusingUpstream({ "anthropic-ratelimit-unified-reset": reset });
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: { headers: async () => ({ authorization: "Bearer real", accountId: null }) },
        allowedNetworks: [],
        limits,
      }),
    );

    assert.equal((await fetch(`${proxy.base}/anthropic/v1/messages/count_tokens`, { method: "POST", body: "{}" })).status, 429, "the Session still sees it");
    await fetch(`${proxy.base}/anthropic/v1/models`);
    await fetch(`${proxy.base}/openai/models`);
    await fetch(`${proxy.base}/openai/memories/trace_summarize`, { method: "POST", body: "{}" });
    assert.deepEqual(limits.snapshot(), { claude: null, codex: null }, "neither Provider is parked for every Board");

    await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    assert.ok(limits.snapshot().claude?.until, "a turn's refusal still is recorded, with its window");

    await proxy.close();
    await upstream.close();
  });

  it("records nothing when the provider answers normally", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [], limits }),
    );
    await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    assert.deepEqual(limits.snapshot(), { claude: null, codex: null });
    await proxy.close();
    await upstream.close();
  });
});

describe("serving the limits to the app", () => {
  it("answers the control token and refuses a Session that has none", async () => {
    const upstream = await refusingUpstream({ "retry-after": "60" });
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "t",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: null,
        allowedNetworks: [],
        limits,
        controlToken: "control-token",
      }),
    );

    await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });

    const refused = await fetch(`${proxy.base}/limits`);
    assert.equal(refused.status, 401, "a Session container can reach this proxy and must not read it");
    assert.deepEqual(await refused.json(), { error: "unauthorized" });

    const wrong = await fetch(`${proxy.base}/limits`, { headers: { authorization: "Bearer guess" } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${proxy.base}/limits`, { headers: { authorization: "Bearer control-token" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ...limits.report(), credentials: { claude: true, codex: false } });

    await proxy.close();
    await upstream.close();
  });

  it("compares the token whole, and matches nothing when none is expected", () => {
    assert.equal(bearerMatches("Bearer control-token", "control-token"), true);
    assert.equal(bearerMatches("Bearer control-toke", "control-token"), false, "a prefix");
    assert.equal(bearerMatches("Bearer control-token-and-more", "control-token"), false, "a longer guess");
    assert.equal(bearerMatches("control-token", "control-token"), false, "without the scheme");
    assert.equal(bearerMatches(undefined, "control-token"), false);
    assert.equal(bearerMatches("Bearer ", ""), false);
    assert.equal(bearerMatches(undefined, ""), false);
  });

  it("is open when no control token is configured, which is the dev case", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [] }),
    );
    const res = await fetch(`${proxy.base}/limits`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      claude: null,
      codex: null,
      authFailures: { claude: null, codex: null },
      refusals: { count: 0, last: null },
      credentials: { claude: true, codex: false },
    });
    await proxy.close();
    await upstream.close();
  });
});

/** Stands in for a provider that answers every call with one status. */
function answeringUpstream(status: () => number): Promise<{ url: URL; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status(), { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: new URL(`http://127.0.0.1:${port}`), close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("noticing that a provider rejected the credential", () => {
  it("records a 401 on a turn, reports it on /limits, and clears it once a turn goes through", async () => {
    let status = 401;
    const upstream = await answeringUpstream(() => status);
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [], limits }),
    );

    assert.equal((await fetch(`${proxy.base}/anthropic/v1/messages?beta=true`, { method: "POST", body: "{}" })).status, 401, "the Session still sees the answer");
    const report = (await (await fetch(`${proxy.base}/limits`)).json()) as { authFailures: Record<string, { status: number; reason: string } | null> };
    assert.equal(report.authFailures.claude?.status, 401);
    assert.equal(report.authFailures.claude?.reason, "POST /v1/messages answered 401");
    assert.equal(report.authFailures.codex, null);

    status = 200;
    await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(limits.report().authFailures.claude, null);

    await proxy.close();
    await upstream.close();
  });

  it("ignores a refusal on a call that does not run a turn", async () => {
    const upstream = await answeringUpstream(() => 403);
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [], limits }),
    );
    await fetch(`${proxy.base}/anthropic/v1/models`);
    await fetch(`${proxy.base}/anthropic/v1/messages/count_tokens`, { method: "POST", body: "{}" });
    assert.equal(limits.report().authFailures.claude, null);
    await proxy.close();
    await upstream.close();
  });

  it("counts a Codex sign-in that cannot be refreshed, without passing on what the token endpoint said", async () => {
    const upstream = await answeringUpstream(() => 200);
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({
        claudeToken: "",
        anthropicUpstream: upstream.url,
        codexUpstream: upstream.url,
        codex: {
          headers: async () => {
            throw new Error('codex token refresh failed: 401 {"error":"refresh_token_reused","account":"acct-real"}');
          },
        },
        allowedNetworks: [],
        limits,
      }),
    );
    assert.equal((await fetch(`${proxy.base}/openai/responses`, { method: "POST", body: "{}" })).status, 502);
    const failure = limits.report().authFailures.codex;
    assert.equal(failure?.status, 401);
    assert.doesNotMatch(JSON.stringify(failure), /acct-real|refresh_token_reused/);

    const health = (await (await fetch(`${proxy.base}/healthz`)).json()) as { credentials: unknown };
    assert.deepEqual(health.credentials, { claude: false, codex: true });
    await proxy.close();
    await upstream.close();
  });
});

describe("counting the calls it refused", () => {
  it("keeps a count and the last path, and reports both on /limits", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const limits = new UsageLimits();
    const proxy = await proxyServer(
      createProxy({ claudeToken: "t", anthropicUpstream: upstream.url, codexUpstream: upstream.url, codex: null, allowedNetworks: [], limits }),
    );
    await fetch(`${proxy.base}/anthropic/api/oauth/usage`);
    await fetch(`${proxy.base}/anthropic/v1/files?purpose=x`, { method: "POST", body: "{}" });
    const report = (await (await fetch(`${proxy.base}/limits`)).json()) as { refusals: { count: number; last: { provider: string; method: string; path: string } } };
    assert.equal(report.refusals.count, 2);
    assert.deepEqual({ ...report.refusals.last, at: undefined }, { at: undefined, provider: "claude", method: "POST", path: "/v1/files" });
    assert.equal(seen.length, 0);
    await proxy.close();
    await upstream.close();
  });
});

/** Stands in for a provider that answers however a test needs, and can be shut while a call hangs. */
function scriptedUpstream(listener: http.RequestListener): Promise<{ url: URL; close: () => Promise<void> }> {
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve({ url: new URL(`http://127.0.0.1:${port}`), close });
    });
  });
}

type Answer = { status: number; body: string; complete: boolean };

/** A POST whose body goes out in pieces with no length, as a streamed body does. */
function postInPieces(base: string, path: string, pieces: number[]): Promise<Answer> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, method: "POST", path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      // `close` rather than `end`, so a response that is cut short still settles, as incomplete.
      res.on("close", () => resolve({ status: res.statusCode ?? 0, body, complete: res.complete }));
    });
    // Once the proxy has answered and hung up, writing on fails; by then the answer has settled this.
    req.on("error", reject);
    for (const size of pieces) req.write(Buffer.alloc(size, "x"));
    req.end();
  });
}

describe("bounding what a Session can hold", () => {
  const config = (upstream: URL, more: Partial<Parameters<typeof createProxy>[0]> = {}) => ({
    claudeToken: "t",
    anthropicUpstream: upstream,
    codexUpstream: upstream,
    codex: null,
    allowedNetworks: [],
    ...more,
  });

  it("closes a connection past the limit without answering it", async () => {
    assert.equal(createServer(config(new URL("http://127.0.0.1"))).maxConnections, MAX_CONNECTIONS);

    const server = createServer(config(new URL("http://127.0.0.1"), { maxConnections: 1 }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };

    const first = net.connect(port, "127.0.0.1");
    const [held] = (await once(server, "connection")) as [net.Socket];
    const second = net.connect(port, "127.0.0.1");
    second.on("error", () => {});
    let answered = "";
    second.on("data", (c) => (answered += c));
    second.write("GET /healthz HTTP/1.1\r\nHost: egress\r\n\r\n");
    await once(second, "close");
    assert.equal(answered, "");

    first.destroy();
    await once(held, "close");
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200, "and serves again once there is room");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("refuses a body that says it is too large before reading it or calling upstream", async () => {
    let calls = 0;
    const upstream = await scriptedUpstream((req, res) => {
      calls++;
      req.resume();
      res.end();
    });
    const proxy = await proxyServer(createProxy(config(upstream.url, { maxBodyBytes: 1024 })));
    const { hostname, port } = new URL(proxy.base);
    // Only the headers go out, so an answer that waited for the body would never come.
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ hostname, port, method: "POST", path: "/anthropic/v1/messages", headers: { "content-length": "2048" }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", () => {});
      req.flushHeaders();
      setTimeout(() => {
        req.destroy();
        resolve(0);
      }, 2_000).unref();
    });
    await proxy.close();
    await upstream.close();
    assert.equal(status, 413);
    assert.equal(calls, 0);
  });

  it("refuses a streamed body as it passes the limit, and forwards one within it", async () => {
    const seen: Seen[] = [];
    const upstream = await upstreamServer(seen);
    const proxy = await proxyServer(createProxy(config(upstream.url, { maxBodyBytes: 1024 })));

    const over = await postInPieces(proxy.base, "/anthropic/v1/messages", [512, 1024]);
    assert.equal(over.status, 413);
    assert.deepEqual(JSON.parse(over.body), { error: "request_too_large" });
    assert.equal(seen.length, 0, "the provider never received a whole request");

    const within = await postInPieces(proxy.base, "/anthropic/v1/messages", [512, 512]);
    assert.equal(within.status, 200);
    assert.equal(seen.at(-1)?.body.length, 1024);
    await proxy.close();
    await upstream.close();
  });

  it("cuts a provider call that goes quiet, before or during its answer", async () => {
    const upstream = await scriptedUpstream((req, res) => {
      req.resume();
      if (req.url!.endsWith("silent")) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\n\n");
    });
    const proxy = await proxyServer(createProxy(config(upstream.url, { upstreamIdleMs: 100 })));
    const started = Date.now();

    const silent = await fetch(`${proxy.base}/anthropic/v1/messages?silent`, { method: "POST", body: "{}" });
    assert.equal(silent.status, 504);
    assert.deepEqual(await silent.json(), { error: "upstream_timeout" });

    const stalled = await postInPieces(proxy.base, "/anthropic/v1/messages?stalls", [2]);
    assert.equal(stalled.status, 200);
    assert.equal(stalled.body, "event: ping\n\n");
    assert.equal(stalled.complete, false, "the Session sees its stream cut, not a clean end");
    const elapsed = Date.now() - started;
    await proxy.close();
    await upstream.close();
    // Node's default agent fires a socket timeout of its own after five seconds; this one must be ours.
    assert.ok(elapsed < 2_000, `cut after the configured idle time, not ${elapsed} ms`);
  });

  it("lets a long streamed turn through for as long as the provider keeps talking", async () => {
    const upstream = await scriptedUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`data: ${sent}\n\n`);
        if (++sent === 10) {
          clearInterval(timer);
          res.end();
        }
      }, 30);
    });
    const proxy = await proxyServer(createProxy(config(upstream.url, { upstreamIdleMs: 200 })));
    const res = await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), Array.from({ length: 10 }, (_, i) => `data: ${i}\n\n`).join(""), "longer than the idle limit, but never idle");
    await proxy.close();
    await upstream.close();
  });

  it("hangs up on the provider when the Session does", async () => {
    let providerHungUp!: (value: boolean) => void;
    const hungUp = new Promise<boolean>((r) => (providerHungUp = r));
    const upstream = await scriptedUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 0\n\n");
      res.on("close", () => providerHungUp(true));
    });
    const proxy = await proxyServer(createProxy(config(upstream.url)));
    const session = new AbortController();
    const res = await fetch(`${proxy.base}/anthropic/v1/messages`, { method: "POST", body: "{}", signal: session.signal });
    assert.equal(res.status, 200);
    session.abort();
    setTimeout(() => providerHungUp(false), 2_000).unref();
    const hungUpInTime = await hungUp;
    await proxy.close();
    await upstream.close();
    assert.equal(hungUpInTime, true, "the provider's connection outlived the Session's");
  });
});
