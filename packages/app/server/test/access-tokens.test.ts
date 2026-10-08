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

// Access tokens, each reaching every Board: made by the User through the REST API, used by an agent
// outside kardboard over MCP, the way Claude Code on the User's own machine would use one.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-access-tokens-"));
process.env.KARDBOARD_DATA_DIR = root;

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

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

beforeEach(async () => {
  for (const t of [schema.accessTokens, schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets" },
    { id: "board-2", slug: "board-two", name: "Board two", repoUrl: "https://github.com/acme/gadgets" },
  ]);
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root" });
});

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeToken(name = "Laptop"): Promise<{ id: string; secret: string }> {
  const res = await call("POST", "/admin/tokens", { name });
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
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column: "ready", creatorKind: "user", creatorId: "user", ...values });
}
const row = async (id: string) => (await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get())!;

describe("making an access token", () => {
  it("shows its secret once, and keeps only a hash of it", async () => {
    const { id, secret } = await makeToken();
    assert.match(secret, /^kbat_[A-Za-z0-9_-]{43}$/);
    const listed = (await (await call("GET", "/admin/tokens")).json()) as Record<string, unknown>[];
    assert.deepEqual(
      listed.map((t) => Object.keys(t).sort()),
      [["createdAt", "id", "lastUsedAt", "name"]],
    );
    const stored = (await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, id)).get())!;
    assert.notEqual(stored.tokenHash, secret);
    assert.ok(!stored.tokenHash.includes(secret));
  });
});

describe("an agent holding an access token", () => {
  it("works a Board as the Agent", async () => {
    const { id, secret } = await makeToken();
    const client = await connect(secret);
    const board = json(await tool(client, "get_board", { board: "board-one" }));
    assert.equal((board.board as { name: string }).name, "Board one");

    const created = json(await tool(client, "create_card", { board: "board-one", title: "Dark mode", description: "Follow the system setting." }));
    const made = await row(created.cardId as string);
    assert.equal(made.creatorKind, "agent");
    assert.equal(made.column, "inbox");
    const moved = json(await tool(client, "move_card", { card_id: made.id, column: "in_progress", revision: made.revision }));
    assert.equal(moved.column, "in_progress");
    await tool(client, "post_comment", { card_id: made.id, body: "Starting on this." });

    const [comment] = await db.select().from(schema.comments);
    assert.equal(comment?.authorKind, "agent");
    const events = await db.select().from(schema.events).where(eq(schema.events.cardId, made.id));
    assert.ok(events.length >= 3);
    for (const e of events) assert.equal(e.payload.accessTokenId, id, `${e.type} names the token it came through`);
    assert.ok((await db.select().from(schema.accessTokens).get())!.lastUsedAt);
  });

  it("edits any card, keeping the words it replaced", async () => {
    await card("theirs", { description: "Make the logo bigger" });
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
      db.insert(schema.comments).values({ id, cardId, authorKind, authorId: authorKind === "user" ? "user" : null, body: id, createdAt: at });
    await comment("q1", "answered", "agent", "2026-09-29T10:00:00.000Z");
    await comment("a1", "answered", "user", "2026-09-29T10:05:00.000Z");
    await comment("q2", "unanswered", "agent", "2026-09-29T10:00:00.000Z");
    await comment("n2", "unanswered", "system", "2026-09-29T10:06:00.000Z");
    await comment("note", "untouched", "user", "2026-09-29T10:00:00.000Z");
    const client = await connect((await makeToken()).secret);
    const board = json(await tool(client, "get_board", { board: "board-one" }));
    const ready = (board.cards as Record<string, { id: string; replyWaiting: boolean }[]>).ready!;
    assert.deepEqual(Object.fromEntries(ready.map((c) => [c.id, c.replyWaiting])), { answered: true, unanswered: false, untouched: false });
  });

  it("puts cards at the top or bottom of a column, which reads top down", async () => {
    await card("first", { column: "ready", position: 1000 });
    await card("second", { column: "ready", position: 2000 });
    await card("working", { column: "in_progress", position: 500 });
    const client = await connect((await makeToken()).secret);
    const order = async (column: string) => ((json(await tool(client, "get_board", { board: "board-one" })).cards as Record<string, { id: string }[]>)[column] ?? []).map((c) => c.id);

    const next = json(await tool(client, "create_card", { board: "board-one", title: "Do this next", column: "ready", position: "top" })).cardId as string;
    const later = json(await tool(client, "create_card", { board: "board-one", title: "Some day", column: "ready" })).cardId as string;
    assert.deepEqual(await order("ready"), [next, "first", "second", later]);

    await tool(client, "move_card", { card_id: "working", column: "ready", revision: 0 });
    assert.deepEqual(await order("ready"), [next, "first", "second", later, "working"], "a move to another column lands at the bottom");
    await tool(client, "move_card", { card_id: "second", column: "ready", revision: 0, position: "top" });
    assert.deepEqual(await order("ready"), ["second", next, "first", later, "working"], "and position reorders within the column");

    const nowhere = await tool(client, "move_card", { card_id: "first", column: "ready", revision: 0 });
    assert.equal(nowhere.isError, true);
    assert.match(text(nowhere), /already in Ready/);
  });

  it("deletes a card the agent created, and only such a card", async () => {
    await card("persons");
    const client = await connect((await makeToken()).secret);
    const made = json(await tool(client, "create_card", { board: "board-one", title: "Made by mistake" })).cardId as string;

    const theirs = await tool(client, "delete_card", { card_id: "persons", revision: 0 });
    assert.equal(theirs.isError, true);
    assert.match(text(theirs), /created by the person/);
    const stale = await tool(client, "delete_card", { card_id: made, revision: 5 });
    assert.equal(stale.isError, true);

    assert.deepEqual(json(await tool(client, "delete_card", { card_id: made, revision: 0 })), { deleted: made });
    assert.equal(await db.select().from(schema.cards).where(eq(schema.cards.id, made)).get(), undefined);
    assert.ok(await db.select().from(schema.cards).where(eq(schema.cards.id, "persons")).get());
    const [deleted] = await db.select().from(schema.events).where(eq(schema.events.type, "card.deleted"));
    assert.equal(deleted?.actorKind, "agent");
  });

  it("is refused a stale revision, and told the current one", async () => {
    await card("c1", { revision: 3 });
    const client = await connect((await makeToken()).secret);
    const result = await tool(client, "move_card", { card_id: "c1", column: "done", revision: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /now at revision 3/);
  });

  // One token, installed once, works every project (ADR 0012): a card needs only its id, and a new one
  // names its Board.
  it("reaches every Board with the one token", async () => {
    await card("here");
    await card("there", { boardId: "board-2" });
    const { id, secret } = await makeToken();
    const client = await connect(secret);
    assert.deepEqual(json(await tool(client, "get_card", { card_id: "here" })).board, { slug: "board-one", name: "Board one" });
    assert.deepEqual(json(await tool(client, "get_card", { card_id: "there" })).board, { slug: "board-two", name: "Board two" });

    assert.equal(json(await tool(client, "move_card", { card_id: "there", column: "in_progress", revision: 0 })).column, "in_progress");
    const [moved] = await db.select().from(schema.events).where(and(eq(schema.events.cardId, "there"), eq(schema.events.type, "card.moved")));
    assert.equal(moved?.boardId, "board-2");
    assert.equal(moved?.payload.accessTokenId, id);

    // A side-finding about the other project, filed while working on this one.
    const filed = json(await tool(client, "create_card", { board: "board-two", title: "Gadgets page 404s" }));
    assert.equal(filed.board, "board-two");
    assert.equal((await row(filed.cardId as string)).boardId, "board-2");
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

  it("records a pull request only from the repository of the card's Board", async () => {
    await card("c1", { column: "in_progress" });
    const client = await connect((await makeToken()).secret);
    const wrongRepo = await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/acme/gadgets/pull/4" });
    assert.equal(wrongRepo.isError, true);
    assert.match(text(wrongRepo), /acme\/widgets/);
    const notPull = await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/acme/widgets/issues/4" });
    assert.equal(notPull.isError, true);
    // The Card shows it as a link, so it is GitHub's own address over https and nothing like it.
    for (const pr_url of ["http://github.com/acme/widgets/pull/4", "https://github.com.example.net/acme/widgets/pull/4"]) {
      assert.equal((await tool(client, "link_pull_request", { card_id: "c1", pr_url })).isError, true, pr_url);
    }
    assert.equal((await row("c1")).prUrl, null);

    const linked = json(await tool(client, "link_pull_request", { card_id: "c1", pr_url: "https://github.com/Acme/Widgets/pull/4", branch: "dark-mode" }));
    assert.equal(linked.prNumber, 4);
    const c1 = await row("c1");
    assert.equal(c1.branch, "dark-mode");
    assert.equal(c1.prUrl, "https://github.com/Acme/Widgets/pull/4");
  });

  it("checks a pull request against the card's own Board, not another one", async () => {
    await card("gadget", { boardId: "board-2", column: "in_progress" });
    const client = await connect((await makeToken()).secret);
    const wrongBoard = await tool(client, "link_pull_request", { card_id: "gadget", pr_url: "https://github.com/acme/widgets/pull/7" });
    assert.equal(wrongBoard.isError, true);
    assert.match(text(wrongBoard), /board-two, has acme\/gadgets/);
    assert.equal((await row("gadget")).prUrl, null);

    assert.equal(json(await tool(client, "link_pull_request", { card_id: "gadget", pr_url: "https://github.com/acme/gadgets/pull/7" })).prNumber, 7);
    const [linked] = await db.select().from(schema.events).where(eq(schema.events.type, "card.pr_linked"));
    assert.equal(linked?.boardId, "board-2");
  });
});

describe("an access token's standing", () => {
  // The row stays, so the events a revoked token signed still name it.
  it("ends when the User revokes it, and stays on record", async () => {
    const { id, secret } = await makeToken();
    assert.equal((await initialize(secret)).status, 200);
    const res = await call("DELETE", `/admin/tokens/${id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await initialize(secret)).status, 401);

    const stored = (await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.id, id)).get())!;
    assert.equal(stored.name, "Laptop");
    assert.ok(stored.revokedAt);
    assert.deepEqual(await (await call("GET", "/admin/tokens")).json(), []);
    assert.equal((await call("DELETE", `/admin/tokens/${id}`)).status, 404, "a token is revoked once");
    assert.equal((await call("DELETE", "/admin/tokens/nope")).status, 404);
  });

  it("is listed while in force, newest first", async () => {
    const laptop = await makeToken("Laptop");
    const desktop = await makeToken("Desktop");
    const ci = await makeToken("CI");
    for (const [id, at] of [[laptop.id, "2026-10-01"], [desktop.id, "2026-10-03"], [ci.id, "2026-10-02"]] as const) {
      await db.update(schema.accessTokens).set({ createdAt: `${at}T00:00:00.000Z` }).where(eq(schema.accessTokens.id, id));
    }
    const names = async () => ((await (await call("GET", "/admin/tokens")).json()) as { name: string }[]).map((t) => t.name);
    assert.deepEqual(await names(), ["Desktop", "CI", "Laptop"]);
    await call("DELETE", `/admin/tokens/${ci.id}`);
    assert.deepEqual(await names(), ["Desktop", "Laptop"]);
  });

  it("turns away a token it never made, and anything that is not one", async () => {
    assert.equal((await initialize("kbat_not-a-real-token")).status, 401);
    assert.equal((await initialize("some-other-token")).status, 401);
  });
});
