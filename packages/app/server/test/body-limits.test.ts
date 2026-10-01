import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { serve } from "@hono/node-server";

// How large a body the JSON API and the MCP server will read: 1 MB, except an Attachment upload,
// which keeps its own 25 MB limit. The MCP route needs the raw Node request, so it is served on a
// real port. Dev authentication signs the API calls in, `X-Dev-User` picking the caller by email.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-body-limits-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { mcp } = await import("../src/routes/mcp.js");

await runMigrations();

const server = serve({ fetch: mcp.fetch, port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BOARD = "board-1";
const MEMBER = "ada@example.com";
const TOKEN = "token-session-1";
const MB = 1024 * 1024;

beforeEach(async () => {
  for (const t of [schema.attachments, schema.sessions, schema.triggers, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
  await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: "ada" });
  await db.insert(schema.cards).values({ id: "card-1", boardId: BOARD, title: "A card", column: "ready", creatorKind: "user", creatorId: "ada" });
  await db.insert(schema.sessions).values({ id: "session-1", boardId: BOARD, cardId: "card-1", kind: "card", provider: "claude", status: "running", tokenHash: createHash("sha256").update(TOKEN).digest("hex") });
});

function call(as: string, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A tool call whose comment is `size` bytes of text, sent by the running Session.
function toolCall(size: number) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_comment", arguments: { card_id: "card-1", body: "x".repeat(size) } } });
}

const mcpHeaders = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
// The server drops a connection whose body it refused without reading, half a second after
// answering, so a refused request keeps its connection to itself rather than leave it to the next.
const refusedHeaders = { ...mcpHeaders, connection: "close" };

describe("the MCP server", () => {
  it("refuses a body over 1 MB from a Session", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: refusedHeaders, body: toolCall(2 * MB) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request body exceeds 1 MB" });
  });

  it("refuses one that arrives in chunks with no length given, as it streams in", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4 * MB) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(mcpUrl, { method: "POST", headers: refusedHeaders, body, duplex: "half" } as RequestInit);
    assert.equal(res.status, 413);
    assert.ok(sent < 4 * MB, `read ${sent} bytes before refusing`);
  });

  it("still takes the largest call a tool accepts", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: mcpHeaders, body: toolCall(20_000) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"result"/);
  });
});

describe("the JSON API", () => {
  it("refuses a body over 1 MB", async () => {
    const res = await call(MEMBER, "POST", "/boards/board-one/cards", { title: "Big", description: "x".repeat(2 * MB) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request body exceeds 1 MB" });
    assert.equal((await db.select().from(schema.cards)).length, 1);
  });

  it("still takes an Attachment over 1 MB", async () => {
    const posted = await call(MEMBER, "POST", "/cards/card-1/comments", { body: "Here is the log" });
    assert.equal(posted.status, 201);
    const comment = (await posted.json()) as { id: string };
    const form = new FormData();
    form.append("file", new File(["x".repeat(3 * MB)], "big.log", { type: "text/plain" }));
    const res = await api.request(`/comments/${comment.id}/attachments`, { method: "POST", headers: { "x-dev-user": MEMBER }, body: form });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { size: number }).size, 3 * MB);
  });
});
