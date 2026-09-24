import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { COOKIE_NAME, type Route } from "../src/preview.js";
import { createRouter, type ExchangeResult } from "../src/router.js";

// The router runs in this process, so an input that used to crash it now fails the whole file.

const secret = "test-secret";
const host = "k6u39mjg.kardboard.cc";

function signed(forHost = host): string {
  const body = Buffer.from(JSON.stringify({ host: forHost, board: "b1", user: "u1", epoch: 1, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function listen(listener: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// A raw request, because the tests need a Host header and paths `fetch` would normalise or refuse.
function send(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the preview router", () => {
  let upstream: Awaited<ReturnType<typeof listen>>;
  let router: Awaited<ReturnType<typeof listen>>;
  let exchange: () => Promise<ExchangeResult>;
  const member = { cookie: `${COOKIE_NAME}=${signed()}` };
  const routes = new Map<string, Route>();
  // Another Preview on the same router, in whatever state a test gives it, and its Member.
  const other = (route: Omit<Route, "host" | "epoch">) => {
    const h = `other${routes.size}.kardboard.cc`;
    routes.set(h, { host: h, epoch: 1, ...route });
    return { host: h, cookie: `${COOKIE_NAME}=${signed(h)}` };
  };

  before(async () => {
    upstream = await listen((req, res) => {
      // A close ends the response early; a reset also errors the router's own request to it.
      if (req.url === "/closed" || req.url === "/reset") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("half a");
        setImmediate(() => (req.url === "/reset" ? res.socket?.resetAndDestroy() : res.socket?.destroy()));
        return;
      }
      if (req.url === "/cookies") {
        res.writeHead(200, { "set-cookie": ["theme=dark; Path=/; Domain=kardboard.cc", `${COOKIE_NAME}=junk; Domain=kardboard.cc`] });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
    });
    routes.set(host, { host, target: `http://127.0.0.1:${upstream.port}`, status: "running", error: null, epoch: 1 });
    router = await listen(
      createRouter({
        route: (h) => routes.get(h),
        exchange: () => exchange(),
        secret,
        publicAppUrl: "https://kardboard.cc",
        secureCookies: true,
      }),
    );
  });
  after(async () => {
    await router.close();
    await upstream.close();
  });

  it("proxies a Member's request and strips their cookies", async () => {
    const res = await send(router.port, "/hello", member);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { path: "/hello", cookie: null });
  });

  it("survives a Preview that drops the connection halfway through a response", async () => {
    for (const path of ["/closed", "/reset"]) {
      await assert.rejects(send(router.port, path, member), "the visitor's connection is cut rather than left hanging");
      assert.equal((await send(router.port, "/hello", member)).status, 200, `the router is still serving after ${path}`);
    }
  });

  it("proxies a path that looks like a host and port instead of throwing on it", async () => {
    const res = await send(router.port, "//x:99999", member);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).path, "//x:99999");
    assert.equal((await send(router.port, "//x:99999")).status, 302, "and sends a stranger to sign in");
  });

  it("refuses a request target that is not a path", async () => {
    assert.equal((await send(router.port, "http://elsewhere.example.com/", member)).status, 400);
  });

  it("answers 502 when the app cannot be reached to spend a sign-in code", async () => {
    exchange = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const res = await send(router.port, "/__kardboard/auth?code=abc&next=%2F");
    assert.equal(res.status, 502);
    assert.match(res.body, /could not be reached/);
  });

  it("returns to the Preview's root rather than write a line break into the Location header", async () => {
    exchange = async () => ({ cookie: "c", maxAgeSeconds: 60 });
    const res = await send(router.port, "/__kardboard/auth?code=abc&next=%2Fa%0D%0ASet-Cookie%3A%20x%3D1");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/");
  });

  it("never sends a Member on to another host after sign-in", async () => {
    exchange = async () => ({ cookie: "c", maxAgeSeconds: 60 });
    for (const next of ["/\\evil.example.com", "/\t/evil.example.com", "//evil.example.com"]) {
      const res = await send(router.port, `/__kardboard/auth?code=abc&next=${encodeURIComponent(next)}`);
      assert.equal(res.headers.location, "/", JSON.stringify(next));
    }
  });

  it("lets a Member in when another Preview planted a same-named cookie ahead of theirs", async () => {
    const res = await send(router.port, "/hello", { cookie: `${COOKIE_NAME}=junk; ${member.cookie}` });
    assert.equal(res.status, 200);
  });

  it("keeps a Preview's cookies on its own host and drops any named like the router's", async () => {
    const res = await send(router.port, "/cookies", member);
    assert.deepEqual(res.headers["set-cookie"], ["theme=dark; Path=/"]);
  });

  it("keeps serving the previous container while a rebuild runs", async () => {
    const rebuilding = other({ target: `http://127.0.0.1:${upstream.port}`, status: "building", error: null });
    const res = await send(router.port, "/hello", rebuilding);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { path: "/hello", cookie: null }, "with the same stripping as ever");
  });

  it("still sends a stranger to sign in rather than to the previous container", async () => {
    const rebuilding = other({ target: `http://127.0.0.1:${upstream.port}`, status: "building", error: null });
    assert.equal((await send(router.port, "/hello", { host: rebuilding.host })).status, 302);
  });

  it("shows the holding page while a first build runs", async () => {
    const first = other({ target: null, status: "building", error: null });
    const res = await send(router.port, "/", first);
    assert.equal(res.status, 503);
    assert.match(res.body, /Building this preview/);
  });

  it("shows the holding page, not an error, in the moment a rebuild swaps containers", async () => {
    const gone = await listen(() => {});
    const port = gone.port;
    await gone.close();
    const swapping = other({ target: `http://127.0.0.1:${port}`, status: "building", error: null });
    const res = await send(router.port, "/", swapping);
    assert.equal(res.status, 503);
    assert.match(res.body, /Building this preview/);
  });

  it("shows a failed build's error even though the previous container is still up", async () => {
    const failed = other({ target: `http://127.0.0.1:${upstream.port}`, status: "failed", error: "build failed: <exit 1>" });
    const res = await send(router.port, "/hello", failed);
    assert.equal(res.status, 502);
    assert.match(res.body, /could not be built/);
    assert.match(res.body, /build failed: &lt;exit 1&gt;/, "escaped, since the error is branch output");
  });
});
