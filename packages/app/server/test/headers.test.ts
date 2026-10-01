import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

// The headers every response carries, and the shell's per-request script nonce. The app is put
// together the way `index.ts` does it, around the real API, and dev authentication signs the tests in.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-headers-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { appShell, securityHeaders } = await import("../src/headers.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const MEMBER = "ada@example.com";
const template = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/index.html"), "utf8");
const DEFAULT_POLICY = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

function appFor(production: boolean, publicUrl: string) {
  const app = new Hono();
  app.use("*", securityHeaders({ production, publicUrl }));
  app.route("/api", api);
  const shell = appShell(template, { clerkPublishableKey: "" });
  app.get("*", (c) => shell(c));
  return app;
}

const app = appFor(false, "http://localhost:5173");

beforeEach(async () => {
  for (const t of [schema.attachments, schema.triggers, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ sessionsEnabled: true, id: "board-1", slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values({ id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" });
  await db.insert(schema.boardMembers).values({ boardId: "board-1", userId: "ada" });
});

function assertCommonHeaders(res: Response) {
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(res.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
}

function nonceOf(res: Response): string {
  const match = /^script-src 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'/.exec(res.headers.get("content-security-policy-report-only") ?? "");
  assert.ok(match, "the shell names a nonce in its script policy");
  return match[1]!;
}

describe("the app shell", () => {
  it("carries the common headers, and refuses to be framed", async () => {
    const res = await app.request("/b/board-one");
    assert.equal(res.status, 200);
    assertCommonHeaders(res);
    assert.equal(res.headers.get("content-security-policy"), DEFAULT_POLICY);
  });

  it("puts its nonce on every script tag and in the runtime config", async () => {
    const res = await app.request("/");
    const nonce = nonceOf(res);
    assert.equal(res.headers.get("content-security-policy-report-only"), `script-src 'nonce-${nonce}' 'strict-dynamic' https:; object-src 'none'; base-uri 'none'`);
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.equal(scripts.length, 2, "the runtime config and the client entry");
    for (const tag of scripts) assert.ok(tag.includes(` nonce="${nonce}"`), tag);
    const config = JSON.parse(/window\.__KARDBOARD_CONFIG__=(\{.*?\})<\/script>/.exec(html)![1]!) as { nonce: string };
    assert.equal(config.nonce, nonce);
  });

  it("uses a new nonce for every request", async () => {
    const first = nonceOf(await app.request("/"));
    const second = nonceOf(await app.request("/"));
    assert.notEqual(first, second);
    assert.equal(Buffer.from(first, "base64").length, 16);
  });
});

describe("an API response", () => {
  it("carries the same headers, and no script policy, since it is not a page", async () => {
    const res = await app.request("/api/me", { headers: { "x-dev-user": MEMBER } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assertCommonHeaders(res);
    assert.equal(res.headers.get("content-security-policy"), DEFAULT_POLICY);
    assert.equal(res.headers.get("content-security-policy-report-only"), null);
  });

  it("keeps the attachment route's own policy", async () => {
    const as = { "x-dev-user": MEMBER };
    const card = (await (await app.request("/api/boards/board-one/cards", { method: "POST", headers: { ...as, "content-type": "application/json" }, body: JSON.stringify({ title: "A card" }) })).json()) as { id: string };
    const comment = (await (await app.request(`/api/cards/${card.id}/comments`, { method: "POST", headers: { ...as, "content-type": "application/json" }, body: JSON.stringify({ body: "a file" }) })).json()) as { id: string };
    const form = new FormData();
    form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
    const att = (await (await app.request(`/api/comments/${comment.id}/attachments`, { method: "POST", headers: as, body: form })).json()) as { id: string };

    const res = await app.request(`/api/attachments/${att.id}`, { headers: as });
    assert.equal(res.status, 200);
    const policy = res.headers.get("content-security-policy") ?? "";
    assert.notEqual(policy, DEFAULT_POLICY);
    assert.match(policy, /\bsandbox\b/);
    assertCommonHeaders(res);
    await res.arrayBuffer();
  });
});

describe("Strict-Transport-Security", () => {
  it("is sent by a production app behind https, without preload", async () => {
    const res = await appFor(true, "https://kardboard.cc").request("/");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  });

  it("is not sent outside production, or over plain http", async () => {
    assert.equal((await app.request("/")).headers.get("strict-transport-security"), null);
    assert.equal((await appFor(false, "https://kardboard.cc").request("/")).headers.get("strict-transport-security"), null);
    assert.equal((await appFor(true, "http://localhost:3070").request("/")).headers.get("strict-transport-security"), null);
  });
});
