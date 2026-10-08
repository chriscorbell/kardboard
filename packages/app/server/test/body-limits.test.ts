import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { serve } from "@hono/node-server";

// How large a body the JSON API and the MCP server will read: 1 MB, except an Attachment upload,
// which keeps its own 25 MB limit. The MCP route needs the raw Node request, so it is served on a
// real port. Dev authentication signs the API calls in as the User.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-body-limits-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";

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
const MB = 1024 * 1024;

// The Access token the agent calls the MCP server with, made afresh for each test.
let token = "";

beforeEach(async () => {
  for (const t of [schema.accessTokens, schema.attachments, schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root" });
  await db.insert(schema.cards).values({ id: "card-1", boardId: BOARD, title: "A card", column: "ready", creatorKind: "user", creatorId: "user" });
  const made = await call("POST", `/admin/boards/${BOARD}/tokens`, { name: "Laptop" });
  assert.equal(made.status, 201);
  token = ((await made.json()) as { secret: string }).secret;
});

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A tool call whose comment is `size` bytes of text, sent by the agent holding the token.
function toolCall(size: number) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post_comment", arguments: { card_id: "card-1", body: "x".repeat(size) } } });
}

const mcpHeaders = () => ({ Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" });
// The server drops a connection whose body it refused without reading, half a second after
// answering, so a refused request keeps its connection to itself rather than leave it to the next.
const refusedHeaders = () => ({ ...mcpHeaders(), connection: "close" });

describe("the MCP server", () => {
  it("refuses a body over 1 MB from an agent", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: refusedHeaders(), body: toolCall(2 * MB) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request body exceeds 1 MB" });
  });

  it("refuses one that arrives in chunks with no length given, as it streams in", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far more than the socket buffers between client and server hold, so a stream cut early is
        // one the client could not have finished writing.
        if (sent >= 32 * MB) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    // The server answers 413 and closes while the client is still writing, so the client sees either
    // that answer or, when the close wins the race, its own write fail. Both are the refusal.
    const res = await fetch(mcpUrl, { method: "POST", headers: refusedHeaders(), body, duplex: "half" } as RequestInit).catch((err: Error & { cause?: { code?: string } }) => {
      if (err.cause?.code === "EPIPE" || err.cause?.code === "ECONNRESET") return null;
      throw err;
    });
    if (res) assert.equal(res.status, 413);
    assert.ok(sent < 32 * MB, `read ${sent} bytes before refusing`);
  });

  it("still takes the largest call a tool accepts", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: mcpHeaders(), body: toolCall(20_000) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"result"/);
  });
});

describe("the JSON API", () => {
  it("refuses a body over 1 MB", async () => {
    const res = await call("POST", "/boards/board-one/cards", { title: "Big", description: "x".repeat(2 * MB) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request body exceeds 1 MB" });
    assert.equal((await db.select().from(schema.cards)).length, 1);
  });

  it("still takes an Attachment over 1 MB", async () => {
    const posted = await call("POST", "/cards/card-1/comments", { body: "Here is the log" });
    assert.equal(posted.status, 201);
    const comment = (await posted.json()) as { id: string };
    const form = new FormData();
    form.append("file", new File(["x".repeat(3 * MB)], "big.log", { type: "text/plain" }));
    const res = await api.request(`/comments/${comment.id}/attachments`, { method: "POST", body: form });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { size: number }).size, 3 * MB);
  });
});
