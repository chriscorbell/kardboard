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

// The Session's own tools, called the way a Session calls them: over MCP with its bearer token.
// The database opens at import time, and the coalesce delay keeps any Trigger from dispatching.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-mcp-tools-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { mcp } = await import("../src/routes/mcp.js");
const { runner } = await import("../src/services/runner-client.js");
const { MAX_CHILDREN } = await import("../src/services/children.js");
const { attachmentContent, looksLikeText } = await import("../src/services/attachment-content.js");

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
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Every client is closed after its test: an open one keeps the server, and so the test run, alive.
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

let sessions = 0;
async function sessionOn(cardId: string | null, kind: "card" | "sweep" = "card"): Promise<{ client: Client; sessionId: string }> {
  const sessionId = `session-${sessions++}`;
  const token = `token-${sessionId}`;
  await db.insert(schema.sessions).values({ id: sessionId, boardId: BOARD, cardId, kind, provider: "claude", status: "running", tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: new Date(Date.now() + sessions).toISOString() });
  const client = new Client({ name: "test-session", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return { client, sessionId };
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
  for (const t of [schema.attachments, schema.approvals, schema.previews, schema.sessions, schema.triggers, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets", previewMode: "runner" });
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
  it("edits a card's title and priority under the revision the Session read, without starting a Session", async () => {
    const { client } = await sessionOn(CARD);
    const result = await call(client, "update_card", { title: "Export invoices as CSV", priority: "high", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(json(result), { cardId: CARD, revision: 1, title: "Export invoices as CSV", priority: "high" });

    const events = await db.select().from(schema.events).where(and(eq(schema.events.cardId, CARD), eq(schema.events.type, "card.edited")));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actorKind, "agent");
    assert.deepEqual((events[0]!.payload as { fields: string[] }).fields.sort(), ["priority", "title"]);
    assert.equal((await db.select().from(schema.triggers)).length, 0, "an Agent edit is not a Trigger");
  });

  it("edits another card on the board when named", async () => {
    await card("card-other");
    const { client } = await sessionOn(CARD);
    const result = await call(client, "update_card", { card_id: "card-other", description: "Steps to reproduce: …", revision: 0 });
    assert.notEqual(result.isError, true, text(result));
    assert.equal((await row("card-other")).description, "Steps to reproduce: …");
  });

  it("refuses an edit made from an old revision and says where the card is now", async () => {
    await db.update(schema.cards).set({ revision: 3 }).where(eq(schema.cards.id, CARD));
    const { client } = await sessionOn(CARD);
    const result = await call(client, "update_card", { title: "Something else", revision: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /changed after revision 2: it is now at revision 3/);
    assert.equal((await row(CARD)).title, `Card ${CARD}`);
  });

  it("refuses a call that changes nothing", async () => {
    const { client } = await sessionOn(CARD);
    const result = await call(client, "update_card", { revision: 0 });
    assert.equal(result.isError, true);
    assert.match(text(result), /nothing to change/);
  });
});

describe("get_board", () => {
  it("lists who can be mentioned, the Admin included, with handles and never an email", async () => {
    const { client } = await sessionOn(CARD);
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
    assert.ok(!text(result).includes("@example.com"), "no email reaches the container");
  });

  it("names each card's parent", async () => {
    await card("card-child", { parentCardId: CARD, creatorKind: "agent", creatorId: null });
    const { client } = await sessionOn(CARD);
    const board = json(await call(client, "get_board")) as { cards: Record<string, { id: string; parentCardId: string | null }[]> };
    assert.equal(board.cards.ready!.find((c) => c.id === "card-child")!.parentCardId, CARD);
    assert.equal(board.cards.in_progress!.find((c) => c.id === CARD)!.parentCardId, null);
  });

  it("sends only the most recent Done cards unless asked for all of them", async () => {
    for (let i = 0; i < 20; i++) await card(`done-${String(i).padStart(2, "0")}`, { column: "done", updatedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    const { client } = await sessionOn(CARD);
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
    const { client } = await sessionOn(CARD);
    const result = await call(client, "get_card");
    assert.deepEqual(json(result).creator, { name: "Ada", handle: "ada" });
    assert.ok(!text(result).includes("@example.com"));
  });

  it("carries the card's earlier sessions, newest first, without the one asking", async () => {
    for (let i = 0; i < 12; i++) {
      await db.insert(schema.sessions).values({ id: `old-${i}`, boardId: BOARD, cardId: CARD, provider: "codex", status: i === 11 ? "timed_out" : "succeeded", outcomeSummary: `run ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    }
    const { client, sessionId } = await sessionOn(CARD);
    const earlier = json(await call(client, "get_card")).earlierSessions as { id: string; status: string; provider: string; outcomeSummary: string }[];
    assert.equal(earlier.length, 10);
    assert.deepEqual(earlier[0], { id: "old-11", status: "timed_out", provider: "codex", startedAt: null, endedAt: null, outcomeSummary: "run 11" });
    assert.ok(!earlier.some((s) => s.id === sessionId));
  });

  it("carries live approvals, its children, and its parent", async () => {
    await card("card-child", { parentCardId: CARD, column: "done", outcome: "implemented" });
    await db.insert(schema.approvals).values([
      { id: "ap-live", cardId: CARD, userId: "ada", prNumber: 7, headSha: SHA_A },
      { id: "ap-void", cardId: CARD, userId: "chris", prNumber: 7, headSha: SHA_B, invalidatedAt: new Date().toISOString() },
    ]);
    const { client } = await sessionOn(CARD);
    const detail = json(await call(client, "get_card"));
    assert.deepEqual(detail.approvals, [{ approver: { name: "Ada", handle: "ada" }, prNumber: 7, headSha: SHA_A, createdAt: (detail.approvals as { createdAt: string }[])[0]!.createdAt }]);
    assert.deepEqual(detail.children, [{ id: "card-child", title: "Card card-child", column: "done", outcome: "implemented" }]);

    const child = json(await call(client, "get_card", { card_id: "card-child" }));
    assert.equal(child.parentCardId, CARD);
  });
});

describe("preview_status", () => {
  async function preview(values: Partial<typeof schema.previews.$inferInsert>) {
    await db.insert(schema.previews).values({ id: "pv-1", boardId: BOARD, cardId: CARD, host: "card-own.kardboard.cc", branch: "kardboard/card-own", ...values });
  }

  it("says when nothing has been requested yet", async () => {
    const { client } = await sessionOn(CARD);
    assert.equal(json(await call(client, "preview_status")).status, "none");
  });

  it("says a running preview is of an older commit than the pull request head", async () => {
    await db.update(schema.cards).set({ prHeadSha: SHA_B }).where(eq(schema.cards.id, CARD));
    await preview({ status: "running", target: "http://kardboard-preview-pv-1:3000", sha: SHA_A });
    const { client } = await sessionOn(CARD);
    const status = json(await call(client, "preview_status"));
    assert.equal(status.status, "running");
    assert.equal(status.builtFromSha, SHA_A);
    assert.equal(status.pullRequestHeadSha, SHA_B);
    assert.equal(status.isOfPullRequestHead, false);
    assert.equal(status.url, "https://card-own.kardboard.cc");
  });

  it("hands a failed build's error, its commit, and the end of its log to the Session that has to fix it", async () => {
    await preview({ status: "failed", error: "build failed: The command '/bin/sh -c pnpm build' returned a non-zero code: 1", sha: SHA_A, failedSha: SHA_B, buildId: "build-1" });
    const log = Array.from({ length: 100 }, (_, i) => `step ${i}`).join("\n");
    const original = runner.previewLog;
    runner.previewLog = async (id) => ({ exists: id === "pv-1", size: log.length, offset: 0, nextOffset: log.length, text: `${log}\nsrc/app.ts(3,1): error TS2304\n`, skipped: false });
    try {
      const { client } = await sessionOn(CARD);
      const status = json(await call(client, "preview_status"));
      assert.equal(status.status, "failed");
      assert.match(String(status.error), /non-zero code/);
      assert.equal(status.failedSha, SHA_B);
      assert.equal(status.builtFromSha, SHA_A, "the last build that ran, not the one that failed");
      const tail = String(status.buildLogTail).split("\n");
      assert.equal(tail.length, 60);
      assert.equal(tail.at(-1), "src/app.ts(3,1): error TS2304");
    } finally {
      runner.previewLog = original;
    }
  });

  it("gives a build the runner refused no log, since the one the runner has is an earlier build's", async () => {
    await preview({ status: "failed", error: "the runner refused the build: fetch failed", buildId: null });
    const original = runner.previewLog;
    runner.previewLog = async () => ({ exists: true, size: 30, offset: 0, nextOffset: 30, text: "src/app.ts(3,1): error TS2304\n", skipped: false });
    try {
      const { client } = await sessionOn(CARD);
      const status = json(await call(client, "preview_status"));
      assert.match(String(status.error), /refused/);
      assert.equal("buildLogTail" in status, false);
    } finally {
      runner.previewLog = original;
    }
  });

  it("says kardboard builds nothing on a board in external preview mode", async () => {
    await db.update(schema.boards).set({ previewMode: "external" });
    const { client } = await sessionOn(CARD);
    assert.equal(json(await call(client, "preview_status")).status, "external");
  });
});

describe("splitting a card with create_card", () => {
  it("makes children of the Session's own card", async () => {
    const { client } = await sessionOn(CARD);
    const result = await call(client, "create_card", { title: "Piece one", parent_card_id: CARD });
    assert.notEqual(result.isError, true, text(result));
    assert.equal((await row(json(result).cardId as string)).parentCardId, CARD);
  });

  it("refuses another card as the parent", async () => {
    await card("card-other");
    const { client } = await sessionOn(CARD);
    const result = await call(client, "create_card", { title: "Piece", parent_card_id: "card-other" });
    assert.equal(result.isError, true);
    assert.match(text(result), /must be your own card, card-own/);
  });

  it("refuses to split a card that is itself a piece of another", async () => {
    await card("card-child", { parentCardId: CARD });
    const { client } = await sessionOn("card-child");
    const result = await call(client, "create_card", { title: "A grandchild", parent_card_id: "card-child" });
    assert.equal(result.isError, true);
    assert.match(text(result), /itself a piece of card card-own, and a piece is not split again/);
  });

  it(`stops at ${MAX_CHILDREN} children`, async () => {
    const { client } = await sessionOn(CARD);
    for (let i = 0; i < MAX_CHILDREN; i++) {
      const made = await call(client, "create_card", { title: `Piece ${i}`, parent_card_id: CARD, column: "blocked" });
      assert.notEqual(made.isError, true, text(made));
    }
    const refused = await call(client, "create_card", { title: "One too many", parent_card_id: CARD });
    assert.equal(refused.isError, true);
    assert.match(text(refused), new RegExp(`already has ${MAX_CHILDREN} child cards`));
  });

  it("gives a sweep, which has no card of its own, no children to make", async () => {
    const { client } = await sessionOn(null, "sweep");
    const result = await call(client, "create_card", { title: "Piece", parent_card_id: CARD });
    assert.equal(result.isError, true);
    assert.match(text(result), /sweep session has no card of its own/);
  });

  it("still creates a card with no parent anywhere on the board", async () => {
    const { client } = await sessionOn(null, "sweep");
    const result = await call(client, "create_card", { title: "An Admin step" });
    assert.notEqual(result.isError, true, text(result));
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
    const { client } = await sessionOn(CARD);
    assert.equal(text(await call(client, "read_attachment", { attachment_id: "att-pdf" })), "brief.pdf: application/pdf, 17 bytes. Binary; not shown.");
  });

  it("returns a text file as text, whatever type it was uploaded as", async () => {
    await upload("att-txt", "notes.md", "application/octet-stream", Buffer.from("# Notes\n\nCafé opens at nine.\n"));
    const { client } = await sessionOn(CARD);
    assert.equal(text(await call(client, "read_attachment", { attachment_id: "att-txt" })), "# Notes\n\nCafé opens at nine.\n");
  });

  it("returns a PNG as an image", async () => {
    await upload("att-png", "shot.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { client } = await sessionOn(CARD);
    const result = await call(client, "read_attachment", { attachment_id: "att-png" });
    assert.equal((result.content as { type: string }[])[0]!.type, "image");
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
