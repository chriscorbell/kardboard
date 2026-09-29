import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

// A Board's Sessions switch: off by default, and while off nothing that happens on the Board is a
// Trigger. Driven through the REST API with dev authentication, as the web app drives it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-sessions-switch-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const ADMIN = "root@example.com";
const MEMBER = "ada@example.com";

beforeEach(async () => {
  for (const t of [schema.sessions, schema.triggers, schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
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

const boardRow = async () => (await db.select().from(schema.boards).where(eq(schema.boards.id, BOARD)).get())!;
const pending = async () => db.select().from(schema.triggers).where(eq(schema.triggers.status, "pending"));

// The whole Board as the settings dialog sends it, with the Sessions switch set.
async function saveBoard(sessionsEnabled: boolean, name = "Board one") {
  return call(ADMIN, "PATCH", `/admin/boards/${BOARD}`, { name, slug: "board-one", provider: "claude", previewMode: "external", maxConcurrentSessions: 3, promptAppend: "", sessionsEnabled });
}

async function newCard(as = MEMBER): Promise<{ id: string; revision: number }> {
  const res = await call(as, "POST", "/boards/board-one/cards", { title: "Add a footer" });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; revision: number };
}

describe("a new Board", () => {
  it("starts without Sessions", async () => {
    const res = await call(ADMIN, "POST", "/admin/boards", { name: "Side project", slug: "side-project" });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { sessionsEnabled: boolean }).sessionsEnabled, false);
  });

  it("can be made with them", async () => {
    const res = await call(ADMIN, "POST", "/admin/boards", { name: "Client site", slug: "client-site", sessionsEnabled: true });
    assert.equal(((await res.json()) as { sessionsEnabled: boolean }).sessionsEnabled, true);
  });
});

describe("a Board without Sessions", () => {
  it("records no Trigger for anything a person does", async () => {
    const card = await newCard();
    await call(MEMBER, "POST", `/cards/${card.id}/comments`, { body: "and a copyright line" });
    const edited = (await (await call(MEMBER, "PATCH", `/cards/${card.id}`, { description: "Dark, with links", revision: card.revision })).json()) as { revision: number };
    await call(MEMBER, "POST", `/cards/${card.id}/move`, { column: "ready", position: 1000, revision: edited.revision });
    assert.deepEqual(await db.select().from(schema.triggers), []);
    const [row] = await db.select().from(schema.cards);
    assert.equal(row!.column, "ready", "the changes themselves still land");
  });

  it("refuses Try again, since no Session ran", async () => {
    const card = await newCard();
    const res = await call(MEMBER, "POST", `/cards/${card.id}/retry`);
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /sessions turned off/);
  });

  it("refuses an Approval, since its own agent merges", async () => {
    await db.insert(schema.cards).values({ id: "card-r", boardId: BOARD, title: "Reviewed", column: "review", creatorKind: "user", creatorId: "ada", prNumber: 3, prHeadSha: "a".repeat(40) });
    const res = await call(MEMBER, "POST", "/cards/card-r/approve", { headSha: "a".repeat(40) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /sessions turned off/);
    assert.deepEqual(await db.select().from(schema.approvals), []);
  });
});

describe("turning Sessions on", () => {
  it("makes later changes Triggers, and none of the ones before", async () => {
    const before = await newCard();
    const res = await saveBoard(true);
    assert.equal(res.status, 200);
    assert.equal((await boardRow()).sessionsEnabled, true);
    assert.deepEqual(await pending(), [], "a card made while Sessions were off asks for nothing");

    await call(MEMBER, "POST", `/cards/${before.id}/comments`, { body: "now please" });
    assert.deepEqual((await pending()).map((t) => t.kind), ["comment_posted"]);
    const [event] = await db.select().from(schema.events).where(eq(schema.events.type, "board.sessions_enabled"));
    assert.equal(event?.actorId, "admin");
  });
});

describe("turning Sessions off", () => {
  beforeEach(async () => {
    await db.update(schema.boards).set({ sessionsEnabled: true }).where(eq(schema.boards.id, BOARD));
  });

  it("drops what was waiting, so turning them on again starts nothing", async () => {
    const card = await newCard();
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, card.id));
    assert.equal((await pending()).length, 1);

    assert.equal((await saveBoard(false)).status, 200);
    assert.deepEqual(await pending(), []);
    assert.equal((await db.select().from(schema.cards).get())!.pendingRerun, false);

    assert.equal((await saveBoard(true)).status, 200);
    assert.deepEqual(await pending(), []);
  });

  it("is refused while a Session is running, and nothing else in the save lands", async () => {
    await db.insert(schema.sessions).values({ id: "session-1", boardId: BOARD, cardId: null, kind: "sweep", provider: "claude", status: "running" });
    const res = await saveBoard(false, "Renamed");
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /still running/);
    const board = await boardRow();
    assert.equal(board.sessionsEnabled, true);
    assert.equal(board.name, "Board one");
  });

  it("leaves the switch alone when a save does not send it", async () => {
    const res = await call(ADMIN, "PATCH", `/admin/boards/${BOARD}`, { name: "Renamed", slug: "board-one" });
    assert.equal(res.status, 200);
    assert.equal((await boardRow()).sessionsEnabled, true);
  });
});
