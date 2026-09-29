import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Access tokens: made by the Admin through the REST API, used by an agent outside kardboard over MCP,
// the way Claude Code on the Admin's own machine would use one. Triggers are held back so a stray
// one would show as a row rather than start anything.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-access-tokens-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { mcp } = await import("../src/routes/mcp.js");

await runMigrations();

const server = serve({ fetch: mcp.fetch, port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BOARD = "board-1";
const ADMIN = "root@example.com";
const MEMBER = "ada@example.com";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

beforeEach(async () => {
  for (const t of [schema.accessTokens, schema.notifications, schema.outboundEmails, schema.triggers, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets" },
    { id: "board-2", slug: "board-two", name: "Board two" },
  ]);
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
  await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: "ada" });
});

function call(as: string, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeToken(boardId = BOARD): Promise<{ id: string; secret: string }> {
  const res = await call(ADMIN, "POST", `/admin/boards/${boardId}/tokens`, { name: "Laptop" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { accessToken: { id: string }; secret: string };
  return { id: body.accessToken.id, secret: body.secret };
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "local-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  clients.push(client);
  return client;
}

// A bare MCP request, for the status the route answers with before any tool runs.
function initialize(secret: string) {
  return fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
  });
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) => (result.content as { type: string; text: string }[])[0]!.text;
const json = (result: ToolResult) => JSON.parse(text(result)) as Record<string, unknown>;
const tool = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

async function card(id: string, values: Partial<typeof schema.cards.$inferInsert> = {}) {
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column: "ready", creatorKind: "user", creatorId: "admin", ...values });
}
const row = async (id: string) => (await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get())!;

describe("making an access token", () => {
  it("shows its secret once, and keeps only a hash of it", async () => {
    const { id, secret } = await makeToken();
    assert.match(secret, /^kbat_[A-Za-z0-9_-]{43}$/);
    const listed = (await (await call(ADMIN, "GET", `/admin/boards/${BOARD}/tokens`)).json()) as Record<string, unknown>[];
    assert.deepEqual(
      listed.map((t) => Object.keys(t).sort()),
      [["boardId", "createdAt", "id", "lastUsedAt", "name"]],
    );
    const stored = (await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, id)).get())!;
    assert.notEqual(stored.tokenHash, secret);
    assert.ok(!stored.tokenHash.includes(secret));
  });

  it("is the Admin's alone", async () => {
    const res = await call(MEMBER, "POST", `/admin/boards/${BOARD}/tokens`, { name: "Mine" });
    assert.equal(res.status, 403);
  });

  it("is refused on a Board that runs Sessions", async () => {
    await db.update(schema.boards).set({ sessionsEnabled: true }).where(eq(schema.boards.id, BOARD));
    const res = await call(ADMIN, "POST", `/admin/boards/${BOARD}/tokens`, { name: "Laptop" });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /runs sessions/);
  });
});

describe("an agent holding an access token", () => {
  it("works the Board as the Agent, and nothing it does is a Trigger", async () => {
    const { id, secret } = await makeToken();
    const client = await connect(secret);
    const board = json(await tool(client, "get_board"));
    assert.equal((board.board as { name: string }).name, "Board one");

    const created = json(await tool(client, "create_card", { title: "Dark mode", description: "Follow the system setting." }));
    const made = await row(created.cardId as string);
    assert.equal(made.creatorKind, "agent");
    assert.equal(made.column, "inbox");
    const moved = json(await tool(client, "move_card", { card_id: made.id, column: "in_progress", revision: made.revision }));
    assert.equal(moved.column, "in_progress");
    await tool(client, "post_comment", { card_id: made.id, body: "Starting on this." });

    assert.deepEqual(await db.select().from(schema.triggers), []);
    const [comment] = await db.select().from(schema.comments);
    assert.equal(comment?.authorKind, "agent");
    const events = await db.select().from(schema.events).where(eq(schema.events.cardId, made.id));
    assert.ok(events.length >= 3);
    for (const e of events) assert.equal(e.payload.accessTokenId, id, `${e.type} names the token it came through`);
    assert.ok((await db.select().from(schema.accessTokens).get())!.lastUsedAt);
  });

  it("edits any card on its Board, keeping the words it replaced", async () => {
    await card("theirs", { creatorId: "ada", description: "Make the logo bigger" });
    const client = await connect((await makeToken()).secret);
    const result = json(await tool(client, "update_card", { card_id: "theirs", description: "Make the logo 20% bigger", revision: 0 }));
    assert.equal(result.revision, 1);
    const [edited] = await db.select().from(schema.events).where(and(eq(schema.events.cardId, "theirs"), eq(schema.events.type, "card.edited")));
    assert.deepEqual(edited?.payload.previous, { description: "Make the logo bigger" });
  });

  it("sees which cards have a person's comment since its own last one", async () => {
    await card("answered");
    await card("unanswered");
    await card("untouched");
    const comment = (id: string, cardId: string, authorKind: "user" | "agent" | "system", at: string) =>
      db.insert(schema.comments).values({ id, cardId, authorKind, authorId: authorKind === "user" ? "admin" : null, body: id, createdAt: at });
    await comment("q1", "answered", "agent", "2026-09-29T10:00:00.000Z");
    await comment("a1", "answered", "user", "2026-09-29T10:05:00.000Z");
    await comment("q2", "unanswered", "agent", "2026-09-29T10:00:00.000Z");
    await comment("n2", "unanswered", "system", "2026-09-29T10:06:00.000Z");
    await comment("note", "untouched", "user", "2026-09-29T10:00:00.000Z");
    const client = await connect((await makeToken()).secret);
    const board = json(await tool(client, "get_board"));
    const ready = (board.cards as Record<string, { id: string; replyWaiting: boolean }[]>).ready!;
    assert.deepEqual(Object.fromEntries(ready.map((c) => [c.id, c.replyWaiting])), { answered: true, unanswered: false, untouched: false });
  });

  it("puts cards at the top or bottom of a column, which reads top down", async () => {
    await card("first", { column: "ready", position: 1000 });
    await card("second", { column: "ready", position: 2000 });
    await card("working", { column: "in_progress", position: 500 });
    const client = await connect((await makeToken()).secret);
    const order = async (column: string) => ((json(await tool(client, "get_board")).cards as Record<string, { id: string }[]>)[column] ?? []).map((c) => c.id);

    const next = json(await tool(client, "create_card", { title: "Do this next", column: "ready", position: "top" })).cardId as string;
    const later = json(await tool(client, "create_card", { title: "Some day", column: "ready" })).cardId as string;
    assert.deepEqual(await order("ready"), [next, "first", "second", later]);

    await tool(client, "move_card", { card_id: "working", column: "ready", revision: 0 });
    assert.deepEqual(await order("ready"), [next, "first", "second", later, "working"], "a move to another column lands at the bottom");
    await tool(client, "move_card", { card_id: "second", column: "ready", revision: 0, position: "top" });
    assert.deepEqual(await order("ready"), ["second", next, "first", later, "working"], "and position reorders within the column");

    const nowhere = await tool(client, "move_card", { card_id: "first", column: "ready", revision: 0 });
    assert.equal(nowhere.isError, true);
    assert.match(text(nowhere), /already in Ready/);
  });

  it("is refused a stale revision, and told the current one", async () => {
    await card("c1", { revision: 3 });
    const client = await connect((await makeToken()).secret);
    const result = await tool(client, "move_card", { card_id: "c1", column: "done", revision: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /now at revision 3/);
  });

  it("cannot reach another Board's card", async () => {
    await db.insert(schema.cards).values({ id: "elsewhere", boardId: "board-2", title: "Not yours" });
    const client = await connect((await makeToken()).secret);
    const result = await tool(client, "get_card", { card_id: "elsewhere" });
    assert.equal(result.isError, true);
    assert.match(text(result), /not on this board/);
  });

  it("closes a card it merged as implemented, with the merge on record", async () => {
    await card("c1", { column: "review", prNumber: 12, prUrl: "https://github.com/acme/widgets/pull/12" });
    const client = await connect((await makeToken()).secret);
    const result = json(await tool(client, "move_card", { card_id: "c1", column: "done", revision: 0, merged: true }));
    assert.equal(result.outcome, "implemented");
    const [merged] = await db.select().from(schema.events).where(and(eq(schema.events.cardId, "c1"), eq(schema.events.type, "card.merged")));
    assert.equal(merged?.payload.prNumber, 12);
    assert.equal(merged?.actorKind, "agent");
  });

  it("closes a card it did not merge as closed", async () => {
    await card("c1", { column: "review" });
    const client = await connect((await makeToken()).secret);
    assert.equal(json(await tool(client, "move_card", { card_id: "c1", column: "done", revision: 0 })).outcome, "closed");
    const misplaced = await tool(client, "move_card", { card_id: "c1", column: "review", revision: 1, merged: true });
    assert.equal(misplaced.isError, true);
  });

  it("records a pull request only from the Board's repository", async () => {
    await card("c1", { column: "in_progress" });
    const client = await connect((await makeToken()).secret);
    const wrongRepo = await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/acme/gadgets/pull/4" });
    assert.equal(wrongRepo.isError, true);
    assert.match(text(wrongRepo), /acme\/widgets/);
    const notPull = await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/acme/widgets/issues/4" });
    assert.equal(notPull.isError, true);

    const linked = json(await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/Acme/Widgets/pull/4", branch: "dark-mode" }));
    assert.equal(linked.prNumber, 4);
    const c1 = await row("c1");
    assert.equal(c1.branch, "dark-mode");
    assert.equal(c1.prHeadSha, null, "kardboard asked GitHub nothing");
  });

  it("does not tell the Admin about their own card moving, but does tell a Member", async () => {
    await card("admins", { creatorId: "admin" });
    await card("adas", { creatorId: "ada" });
    const client = await connect((await makeToken()).secret);
    await tool(client, "move_card", { card_id: "admins", column: "review", revision: 0 });
    await tool(client, "move_card", { card_id: "adas", column: "review", revision: 0 });
    const told = await db.select().from(schema.notifications);
    assert.deepEqual(
      told.map((n) => [n.userId, n.cardId]),
      [["ada", "adas"]],
    );
  });
});

describe("an access token's standing", () => {
  it("is turned away while its Board runs Sessions, and works again once they are off", async () => {
    const { secret } = await makeToken();
    await db.update(schema.boards).set({ sessionsEnabled: true }).where(eq(schema.boards.id, BOARD));
    const refused = await initialize(secret);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, "sessions_on");

    await db.update(schema.boards).set({ sessionsEnabled: false }).where(eq(schema.boards.id, BOARD));
    assert.equal((await initialize(secret)).status, 200);
  });

  it("ends when the Admin revokes it", async () => {
    const { id, secret } = await makeToken();
    assert.equal((await call(ADMIN, "DELETE", `/admin/boards/${BOARD}/tokens/${id}`)).status, 200);
    assert.equal((await initialize(secret)).status, 401);
    const [revoked] = await db.select().from(schema.events).where(eq(schema.events.type, "access_token.revoked"));
    assert.equal(revoked?.payload.name, "Laptop");
  });

  it("is only ever a token for its own Board", async () => {
    const { id } = await makeToken();
    assert.equal((await call(ADMIN, "DELETE", `/admin/boards/board-2/tokens/${id}`)).status, 404);
    assert.equal((await db.select().from(schema.accessTokens)).length, 1);
  });

  it("goes with its Board", async () => {
    await makeToken();
    await db.delete(schema.boards).where(eq(schema.boards.id, BOARD));
    assert.deepEqual(await db.select().from(schema.accessTokens), []);
  });

  it("is not mistaken for a Session's token, nor a Session's for it", async () => {
    assert.equal((await initialize("kbat_not-a-real-token")).status, 401);
    assert.equal((await initialize("some-session-token")).status, 401);
  });
});
