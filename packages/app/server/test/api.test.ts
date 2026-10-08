import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { Board, Card } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
// Every request is the User.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-api-"));
process.env.KARDBOARD_DATA_DIR = root;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { createComment } = await import("../src/services/comments.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const AGENT = { kind: "agent" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-one", name: "Board one" },
    { id: "board-2", slug: "board-two", name: "Board two" },
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

async function newCard(values: Record<string, unknown> = { title: "A card" }): Promise<Card> {
  const res = await call("POST", "/boards/board-one/cards", values);
  assert.equal(res.status, 201);
  return (await res.json()) as Card;
}

describe("a request that fails validation", () => {
  it("names the first thing wrong with it, as a string the client can show", async () => {
    const res = await call("POST", "/boards/board-one/cards", { title: "" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: unknown };
    assert.equal(typeof body.error, "string");
    assert.match(body.error as string, /^title: /);
  });
});

describe("the boards", () => {
  it("are all listed for the User", async () => {
    const boards = (await (await call("GET", "/boards")).json()) as Board[];
    assert.deepEqual(boards.map((b) => b.slug), ["board-one", "board-two"]);
  });
});

describe("creating a card", () => {
  it("puts it in Backlog unless the User picks a column", async () => {
    assert.equal((await newCard()).column, "inbox");
    const ready = await newCard({ title: "Next up", column: "ready" });
    assert.equal(ready.column, "ready");
    assert.equal(ready.creatorKind, "user");
    assert.equal(ready.creatorId, "user");
  });

  it("makes it a task unless the User picks a type, and lets the type change", async () => {
    assert.equal((await newCard()).type, "task");
    const idea = await newCard({ title: "Offline mode", type: "idea" });
    assert.equal(idea.type, "idea");
    const res = await call("PATCH", `/cards/${idea.id}`, { type: "feature", revision: idea.revision });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Card).type, "feature");
    assert.equal((await call("POST", "/boards/board-one/cards", { title: "Epic", type: "epic" })).status, 400);
  });
});

describe("editing a comment", () => {
  it("works on the User's own comment", async () => {
    const card = await newCard();
    const posted = await call("POST", `/cards/${card.id}/comments`, { body: "first thought" });
    const comment = (await posted.json()) as { id: string };

    const res = await call("PATCH", `/comments/${comment.id}`, { body: "second thought" });
    assert.equal(res.status, 200);
    const row = (await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id)).get())!;
    assert.equal(row.body, "second thought");
  });

  it("is refused on the Agent's comment, whose words are the Agent's", async () => {
    const card = await newCard();
    const agents = await createComment({ cardId: card.id, body: "I opened a pull request.", actor: AGENT });

    const res = await call("PATCH", `/comments/${agents.id}`, { body: "Something else" });
    assert.equal(res.status, 403);
    const row = (await db.select().from(schema.comments).where(eq(schema.comments.id, agents.id)).get())!;
    assert.equal(row.body, "I opened a pull request.");
  });
});
