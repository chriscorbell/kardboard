import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The agent's tools, called the way an agent outside kardboard calls them: over MCP with an Access
// token, which the Admin makes through the REST API. The database opens at import time, and dev
// authentication signs the Admin in.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-mcp-tools-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { mcp } = await import("../src/routes/mcp.js");
const { attachmentContent, INLINE_IMAGE_LIMIT, looksLikeText, sniffImage } = await import("../src/services/attachment-content.js");

await runMigrations();

const server = serve({ fetch: mcp.fetch, port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BOARD = "board-1";
const CARD = "card-own";

// Every client is closed after its test: an open one keeps the server, and so the test run, alive.
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function agent(): Promise<{ client: Client; tokenId: string }> {
  const res = await api.request(`/admin/boards/${BOARD}/tokens`, {
    method: "POST",
    headers: { "x-dev-user": "chris@example.com", "content-type": "application/json" },
    body: JSON.stringify({ name: "Laptop" }),
  });
  assert.equal(res.status, 201);
  const made = (await res.json()) as { accessToken: { id: string }; secret: string };
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${made.secret}` } } }));
  clients.push(client);
  return { client, tokenId: made.accessToken.id };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) => (result.content as { type: string; text: string }[])[0]!.text;
const json = (result: ToolResult) => JSON.parse(text(result)) as Record<string, unknown>;

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({ name, arguments: args });
}

async function card(id: string, values: Partial<typeof schema.cards.$inferInsert> = {}) {
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column: "ready", creatorKind: "user", creatorId: "ada", ...values });
}

const row = async (id: string) => (await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get())!;

beforeEach(async () => {
  for (const t of [schema.accessTokens, schema.attachments, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets" });
  await db.insert(schema.users).values([
    { id: "chris", email: "chris@example.com", handle: "chris", name: "Chris", role: "admin", status: "active" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" },
    { id: "gone", email: "gone@example.com", handle: "gone", name: "Gone", role: "member", status: "revoked" },
  ]);
  await db.insert(schema.boardMembers).values([
    { boardId: BOARD, userId: "ada" },
    { boardId: BOARD, userId: "gone" },
  ]);
  await card(CARD, { column: "in_progress", branch: "kardboard/card-own" });
});

describe("update_card", () => {
  it("edits a card's title and priority under the revision the agent read", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, title: "Export invoices as CSV", priority: "high", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(json(result), { cardId: CARD, revision: 1, title: "Export invoices as CSV", priority: "high" });

    const events = await db.select().from(schema.events).where(and(eq(schema.events.cardId, CARD), eq(schema.events.type, "card.edited")));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actorKind, "agent");
    assert.deepEqual((events[0]!.payload as { fields: string[] }).fields.sort(), ["priority", "title"]);
  });

  it("keeps what each changed field said before, so the author's words are never lost", async () => {
    await db.update(schema.cards).set({ description: "make the export work pls" }).where(eq(schema.cards.id, CARD));
    const { client, tokenId } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, description: "Export invoices as CSV.\n\nOriginal ask: make the export work pls", priority: "none", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    const [edited] = await db.select().from(schema.events).where(and(eq(schema.events.cardId, CARD), eq(schema.events.type, "card.edited")));
    assert.deepEqual(edited!.payload, { accessTokenId: tokenId, fields: ["description"], previous: { description: "make the export work pls" } }, "an unchanged priority is not an edit");
  });

  it("refuses an edit made from an old revision and says where the card is now", async () => {
    await db.update(schema.cards).set({ revision: 3 }).where(eq(schema.cards.id, CARD));
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, title: "Something else", revision: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /changed after revision 2: it is now at revision 3/);
    assert.equal((await row(CARD)).title, `Card ${CARD}`);
  });

  it("refuses a call that changes nothing", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, revision: 0 });
    assert.equal(result.isError, true);
    assert.match(text(result), /nothing to change/);
  });
});

describe("get_board", () => {
  it("lists who can be mentioned, the Admin included, with handles and never an email", async () => {
    const { client } = await agent();
    const result = await call(client, "get_board");
    const board = json(result) as { members: { id: string; name: string; handle: string; role: string }[] };
    assert.deepEqual(
      board.members.map((m) => [m.handle, m.role]).sort(),
      [
        ["ada", "member"],
        ["chris", "admin"],
      ],
      "a revoked member is left out, since a Mention would reach nobody",
    );
    assert.deepEqual(Object.keys(board.members[0]!).sort(), ["handle", "id", "name", "role"]);
    assert.ok(!text(result).includes("@example.com"), "no email reaches the agent");
  });

  it("names each card's parent", async () => {
    await card("card-child", { parentCardId: CARD, creatorKind: "agent", creatorId: null });
    const { client } = await agent();
    const board = json(await call(client, "get_board")) as { cards: Record<string, { id: string; parentCardId: string | null }[]> };
    assert.equal(board.cards.ready!.find((c) => c.id === "card-child")!.parentCardId, CARD);
    assert.equal(board.cards.in_progress!.find((c) => c.id === CARD)!.parentCardId, null);
  });

  it("sends only the most recent Done cards unless asked for all of them", async () => {
    for (let i = 0; i < 20; i++) await card(`done-${String(i).padStart(2, "0")}`, { column: "done", updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    const { client } = await agent();
    const some = json(await call(client, "get_board")) as { cards: { done: { id: string }[] }; doneOmitted: number };
    assert.equal(some.cards.done.length, 15);
    assert.equal(some.doneOmitted, 5);
    assert.equal(some.cards.done[0]!.id, "done-19", "newest first");
    assert.ok(!some.cards.done.some((c) => c.id === "done-04"), "the oldest are the ones left out");

    const all = json(await call(client, "get_board", { include_all_done: true })) as { cards: { done: unknown[] }; doneOmitted: number };
    assert.equal(all.cards.done.length, 20);
    assert.equal(all.doneOmitted, 0);
  });
});

describe("get_card", () => {
  it("names the creator by name and handle only", async () => {
    const { client } = await agent();
    const result = await call(client, "get_card", { card_id: CARD });
    assert.deepEqual(json(result).creator, { name: "Ada", handle: "ada" });
    assert.ok(!text(result).includes("@example.com"));
  });

  it("carries its children and its parent", async () => {
    await card("card-child", { parentCardId: CARD, column: "done", outcome: "implemented" });
    const { client } = await agent();
    const detail = json(await call(client, "get_card", { card_id: CARD }));
    assert.deepEqual(detail.children, [{ id: "card-child", title: "Card card-child", column: "done", outcome: "implemented" }]);

    const child = json(await call(client, "get_card", { card_id: "card-child" }));
    assert.equal(child.parentCardId, CARD);
  });
});

describe("read_attachment", () => {
  async function upload(id: string, filename: string, mime: string, bytes: Buffer) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = path.join(root, "uploads", sha256.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sha256), bytes);
    await db.insert(schema.comments).values({ id: `comment-${id}`, cardId: CARD, authorKind: "user", authorId: "ada", body: "see attached" }).onConflictDoNothing();
    await db.insert(schema.attachments).values({ id, commentId: `comment-${id}`, filename, mime, size: bytes.length, sha256 });
  }

  it("describes a PDF instead of decoding it as text", async () => {
    await upload("att-pdf", "brief.pdf", "application/pdf", Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0x01])]));
    const { client } = await agent();
    assert.equal(text(await call(client, "read_attachment", { attachment_id: "att-pdf" })), "brief.pdf: application/pdf, 17 bytes. Binary; not shown.");
  });

  it("returns a text file as text, whatever type it was uploaded as", async () => {
    await upload("att-txt", "notes.md", "application/octet-stream", Buffer.from("# Notes\n\nCafé opens at nine.\n"));
    const { client } = await agent();
    assert.equal(text(await call(client, "read_attachment", { attachment_id: "att-txt" })), "# Notes\n\nCafé opens at nine.\n");
  });

  it("returns a PNG as an image", async () => {
    await upload("att-png", "shot.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { client } = await agent();
    const result = await call(client, "read_attachment", { attachment_id: "att-png" });
    assert.equal((result.content as { type: string }[])[0]!.type, "image");
  });

  it("sends an image under the type its bytes say, not the one it was uploaded as", async () => {
    await upload("att-jpeg", "photo.png", "image/png", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
    const { client } = await agent();
    const [content] = (await call(client, "read_attachment", { attachment_id: "att-jpeg" })).content as { type: string; mimeType?: string }[];
    assert.deepEqual([content!.type, content!.mimeType], ["image", "image/jpeg"]);
  });
});

describe("which attachments go to the model as images", () => {
  const png = (bytes: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]);

  it("knows the four vision formats by their first bytes", () => {
    assert.equal(sniffImage(png(16)), "image/png");
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from("GIF89a\x01\x00", "latin1")), "image/gif");
    assert.equal(sniffImage(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
    assert.equal(sniffImage(Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1")), null, "a RIFF file is not always a WebP");
    assert.equal(sniffImage(Buffer.from([0x89, 0x50])), null);
  });

  it("finds a PNG uploaded under a generic type", () => {
    const content = attachmentContent({ filename: "shot", mime: "application/octet-stream" }, png(16));
    assert.equal(content.type === "image" && content.mimeType, "image/png");
  });

  it("describes an image too large for the model rather than sending it", () => {
    // The model's limit is 5 MB of base64, which is three quarters of that in file size.
    const largest = (INLINE_IMAGE_LIMIT / 4) * 3;
    assert.equal(attachmentContent({ filename: "ok.png", mime: "image/png" }, png(largest)).type, "image");
    const content = attachmentContent({ filename: "full-page.png", mime: "image/png" }, png(largest + 1));
    assert.equal(content.type, "text");
    assert.match((content as { text: string }).text, /^full-page\.png: image\/png, 3\.8 MB\. Too large to show/);
  });

  it("does not send bytes that only claim to be an image", () => {
    const content = attachmentContent({ filename: "shot.png", mime: "image/png" }, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
    assert.deepEqual(content, { type: "text", text: "shot.png: uploaded as image/png, 6 bytes, but its contents are not a PNG, JPEG, GIF, or WebP image. Not shown." });
  });
});

describe("telling text from binary", () => {
  it("takes valid UTF-8 without NUL bytes as text", () => {
    assert.equal(looksLikeText(Buffer.from("plain, and ünïcödé too")), true);
    assert.equal(looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false);
    assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0x41])), false);
  });

  it("does not hold a character cut off at the end of the sample against the file", () => {
    const long = Buffer.from(`${"a".repeat(8_191)}é and more`);
    assert.equal(looksLikeText(long), true);
  });

  it("points out an image format the model cannot view", () => {
    const content = attachmentContent({ filename: "IMG_0001.HEIC", mime: "image/heic" }, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    assert.equal(content.type, "text");
    assert.match((content as { text: string }).text, /IMG_0001\.HEIC: image\/heic, 8 bytes\. Binary; not shown\. The model cannot view this image format/);
  });

  it("reads an SVG as the text it is", () => {
    const content = attachmentContent({ filename: "logo.svg", mime: "image/svg+xml" }, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    assert.deepEqual(content, { type: "text", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
  });
});
