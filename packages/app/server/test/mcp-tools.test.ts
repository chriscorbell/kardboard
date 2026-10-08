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
// token, which the User makes through the REST API. The database opens at import time, and dev
// authentication signs the User in.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-mcp-tools-"));
process.env.KARDBOARD_DATA_DIR = root;

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
  const res = await api.request("/admin/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column: "ready", creatorKind: "user", creatorId: "chris", ...values });
}

const row = async (id: string) => (await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get())!;

beforeEach(async () => {
  for (const t of [schema.accessTokens, schema.attachments, schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets" });
  await db.insert(schema.users).values({ id: "chris", email: "chris@example.com", name: "Chris" });
  await card(CARD, { column: "in_progress", branch: "kardboard/card-own" });
});

describe("the server's instructions", () => {
  it("tell an agent how to find its board, and to file side-findings in Backlog", async () => {
    const { client } = await agent();
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /git remote get-url origin/);
    assert.match(instructions, /list_boards/);
    assert.match(instructions, /create_board/);
    assert.match(instructions, /File side-findings without asking[^]*in Backlog/);
    assert.match(instructions, /the type that fits/);
  });
});

describe("update_card", () => {
  it("edits a card's title and priority under the revision the agent read", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, title: "Export invoices as CSV", priority: "high", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(json(result), { cardId: CARD, revision: 1, title: "Export invoices as CSV", type: "task", priority: "high" });

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

  it("changes a card's type, keeping the one it replaced", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, type: "bug", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(json(result).type, "bug");
    assert.equal((await row(CARD)).type, "bug");
    const [edited] = await db.select().from(schema.events).where(and(eq(schema.events.cardId, CARD), eq(schema.events.type, "card.edited")));
    assert.deepEqual((edited!.payload as { previous: unknown }).previous, { type: "task" });
  });

  it("refuses a type outside the fixed set", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, type: "epic", revision: 0 });
    assert.equal(result.isError, true);
    assert.equal((await row(CARD)).type, "task");
  });

  it("refuses a call that changes nothing", async () => {
    const { client } = await agent();
    const result = await call(client, "update_card", { card_id: CARD, revision: 0 });
    assert.equal(result.isError, true);
    assert.match(text(result), /nothing to change/);
  });
});

describe("get_board", () => {
  it("names each card's creator, and never sends an email", async () => {
    const { client } = await agent();
    const result = await call(client, "get_board", { board: "board-one" });
    const board = json(result) as { cards: Record<string, { id: string; creator: string }[]> };
    assert.equal(board.cards.in_progress!.find((c) => c.id === CARD)!.creator, "Chris");
    assert.ok(!text(result).includes("@example.com"), "no email reaches the agent");
  });

  it("names each card's parent", async () => {
    await card("card-child", { parentCardId: CARD, creatorKind: "agent", creatorId: null });
    const { client } = await agent();
    const board = json(await call(client, "get_board", { board: "board-one" })) as { cards: Record<string, { id: string; parentCardId: string | null }[]> };
    assert.equal(board.cards.ready!.find((c) => c.id === "card-child")!.parentCardId, CARD);
    assert.equal(board.cards.in_progress!.find((c) => c.id === CARD)!.parentCardId, null);
  });

  it("sends only the most recent Done cards unless asked for all of them", async () => {
    for (let i = 0; i < 20; i++) await card(`done-${String(i).padStart(2, "0")}`, { column: "done", updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    const { client } = await agent();
    const some = json(await call(client, "get_board", { board: "board-one" })) as { cards: { done: { id: string }[] }; doneOmitted: number };
    assert.equal(some.cards.done.length, 15);
    assert.equal(some.doneOmitted, 5);
    assert.equal(some.cards.done[0]!.id, "done-19", "newest first");
    assert.ok(!some.cards.done.some((c) => c.id === "done-04"), "the oldest are the ones left out");

    const all = json(await call(client, "get_board", { board: "board-one", include_all_done: true })) as { cards: { done: unknown[] }; doneOmitted: number };
    assert.equal(all.cards.done.length, 20);
    assert.equal(all.doneOmitted, 0);
  });
});

describe("list_boards", () => {
  it("counts each board's open cards by column, and the replies waiting there", async () => {
    await db.insert(schema.boards).values({ id: "board-2", slug: "board-two", name: "Board two" });
    await card("backlog", { column: "inbox" });
    await card("asked", { column: "ready" });
    await card("answered-long-ago", { column: "done" });
    await card("told", { column: "ready" });
    await card("stuck", { boardId: "board-2", column: "blocked" });
    const comment = (id: string, cardId: string, authorKind: "user" | "agent", at: string) =>
      db.insert(schema.comments).values({ id, cardId, authorKind, authorId: authorKind === "user" ? "chris" : null, body: id, createdAt: `2026-10-07T10:0${at}:00.000Z` });
    // A reply waits where the person spoke after the agent, and only on a card still open.
    for (const cardId of ["asked", "answered-long-ago", "stuck"]) {
      await comment(`${cardId}-q`, cardId, "agent", "0");
      await comment(`${cardId}-a`, cardId, "user", "5");
    }
    await comment("told-a", "told", "user", "0");
    await comment("told-q", "told", "agent", "5");

    const { client } = await agent();
    assert.deepEqual(json(await call(client, "list_boards")), {
      boards: [
        { slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets", open: { inbox: 1, blocked: 0, ready: 2, in_progress: 1, review: 0 }, replyWaiting: 1 },
        { slug: "board-two", name: "Board two", repoUrl: null, open: { inbox: 0, blocked: 1, ready: 0, in_progress: 0, review: 0 }, replyWaiting: 1 },
      ],
    });
  });
});

describe("create_board", () => {
  it("makes a board with its repository's address written the one way, as the agent", async () => {
    const { client, tokenId } = await agent();
    const result = await call(client, "create_board", { name: "Gadget Shop", repo_url: "git@github.com:Acme/Gadgets.git" });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(json(result), { slug: "gadget-shop", name: "Gadget Shop", repoUrl: "https://github.com/Acme/Gadgets" });

    const made = (await db.select().from(schema.boards).where(eq(schema.boards.slug, "gadget-shop")).get())!;
    const [created] = await db.select().from(schema.events).where(eq(schema.events.boardId, made.id));
    assert.equal(created?.type, "board.created");
    assert.equal(created?.actorKind, "agent");
    assert.deepEqual(created?.payload, { accessTokenId: tokenId, name: "Gadget Shop", slug: "gadget-shop" });
    // And the agent finds it again from its checkout.
    assert.equal((json(await call(client, "get_board", { board: "https://github.com/acme/gadgets.git" })).board as { slug: string }).slug, "gadget-shop");
  });

  it("takes the slug it is given, and needs no repository", async () => {
    const { client } = await agent();
    assert.deepEqual(json(await call(client, "create_board", { name: "Reading list", slug: "Books 2026" })), { slug: "books-2026", name: "Reading list", repoUrl: null });
  });

  it("refuses a repository another board has, in whatever form, and names that board", async () => {
    const { client } = await agent();
    for (const repo_url of ["https://github.com/acme/widgets", "https://github.com/ACME/Widgets.git/", "git@github.com:acme/widgets.git"]) {
      const result = await call(client, "create_board", { name: "Widgets again", repo_url });
      assert.equal(result.isError, true, repo_url);
      assert.match(text(result), /board board-one already has/);
    }
    assert.equal((await db.select().from(schema.boards)).length, 1);
  });

  it("refuses a slug already taken", async () => {
    const { client } = await agent();
    const sameName = await call(client, "create_board", { name: "Board One" });
    assert.equal(sameName.isError, true);
    assert.match(text(sameName), /the slug board-one is taken: pass another as slug/);
    assert.equal((await call(client, "create_board", { name: "Something else", slug: "board-one" })).isError, true);
    assert.equal((await db.select().from(schema.boards)).length, 1);
  });

  it("refuses an address that is not a GitHub repository", async () => {
    const { client } = await agent();
    for (const repo_url of ["https://gitlab.com/acme/gadgets", "https://github.com/acme", "https://github.com/acme/gadgets/pull/3", "gadgets"]) {
      const result = await call(client, "create_board", { name: "Gadgets", repo_url });
      assert.equal(result.isError, true, repo_url);
      assert.match(text(result), /is not a GitHub repository address/);
    }
    assert.equal((await db.select().from(schema.boards)).length, 1);
  });
});

// get_board and create_card take a board's slug, or its repository as `git remote get-url origin`
// prints it, which is how an agent finds the board for the checkout it is in.
describe("naming a board", () => {
  const ADDRESSES = [
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "https://github.com/Acme/Widgets",
  ];

  it("finds a board by its slug, in any case", async () => {
    const { client } = await agent();
    for (const board of ["board-one", "Board-One", " board-one "]) {
      const result = await call(client, "get_board", { board });
      assert.deepEqual(json(result).board, { slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets" }, board);
    }
  });

  it("finds a board by its repository, however the address is written", async () => {
    const { client } = await agent();
    for (const board of ADDRESSES) {
      const result = await call(client, "get_board", { board });
      assert.notEqual(result.isError, true, `${board}: ${text(result)}`);
      assert.equal((json(result).board as { slug: string }).slug, "board-one", board);
    }
  });

  it("matches the address a board was saved with in another form", async () => {
    await db.update(schema.boards).set({ repoUrl: "https://github.com/Acme/Widgets.git" }).where(eq(schema.boards.id, BOARD));
    const { client } = await agent();
    assert.equal((json(await call(client, "get_board", { board: "git@github.com:acme/widgets" })).board as { slug: string }).slug, "board-one");
  });

  it("files a card as a task unless the agent gives its type", async () => {
    const { client } = await agent();
    const plain = json(await call(client, "create_card", { board: "board-one", title: "Update the readme" }));
    const bug = json(await call(client, "create_card", { board: "board-one", title: "Search drops accents", type: "bug" }));
    assert.equal((await row(plain.cardId as string)).type, "task");
    assert.equal((await row(bug.cardId as string)).type, "bug");
    const board = json(await call(client, "get_board", { board: "board-one" })) as { cards: Record<string, { id: string; type: string }[]> };
    assert.equal(board.cards.inbox!.find((c) => c.id === bug.cardId)!.type, "bug");
  });

  it("files a card on the board named, by slug or by repository", async () => {
    const { client } = await agent();
    for (const board of ["board-one", ...ADDRESSES]) {
      const result = json(await call(client, "create_card", { board, title: `Filed through ${board}` }));
      assert.equal(result.board, "board-one", board);
      assert.equal((await row(result.cardId as string)).boardId, BOARD, board);
    }
  });

  it("points an agent at list_boards and create_board when no board matches", async () => {
    const { client } = await agent();
    for (const [name, args] of [
      ["get_board", { board: "board-two" }],
      ["get_board", { board: "https://github.com/acme/gadgets" }],
      ["create_card", { board: "git@github.com:acme/gadgets.git", title: "Nowhere to go" }],
    ] as const) {
      const result = await call(client, name, args);
      assert.equal(result.isError, true, `${name} ${args.board}`);
      assert.match(text(result), /no board matches .*list_boards.*create_board/s);
    }
    assert.equal((await db.select().from(schema.cards)).length, 1, "only the card the test started with");
  });
});

describe("get_card", () => {
  it("names its board, its creator, and each comment's author by name only", async () => {
    await db.insert(schema.comments).values([
      { id: "comment-person", cardId: CARD, authorKind: "user", authorId: "chris", body: "Use the brand blue.", createdAt: "2026-10-07T10:00:00.000Z" },
      { id: "comment-agent", cardId: CARD, authorKind: "agent", authorId: null, body: "Done.", createdAt: "2026-10-07T10:05:00.000Z" },
    ]);
    const { client } = await agent();
    const result = await call(client, "get_card", { card_id: CARD });
    const detail = json(result) as { board: unknown; creator: unknown; comments: Record<string, unknown>[] };
    assert.deepEqual(detail.board, { slug: "board-one", name: "Board one" });
    assert.deepEqual(detail.creator, { name: "Chris" });
    assert.deepEqual(
      detail.comments.map((c) => c.author),
      ["Chris", "you"],
    );
    assert.deepEqual(Object.keys(detail.comments[0]!).sort(), ["attachments", "author", "body", "createdAt", "editedAt", "id"]);
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
    await db.insert(schema.comments).values({ id: `comment-${id}`, cardId: CARD, authorKind: "user", authorId: "chris", body: "see attached" }).onConflictDoNothing();
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
