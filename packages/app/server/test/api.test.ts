import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. Dev
// authentication is what the tests sign in with: `X-Dev-User` picks the caller by email.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-api-"));
process.env.KARDBOARD_DATA_DIR = root;
// These tests sign in with dev authentication, whatever a local .env chooses.
process.env.KARDBOARD_AUTH = "dev";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const MEMBER = "ada@example.com";

beforeEach(async () => {
  for (const t of [schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" },
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

describe("a request that fails validation", () => {
  it("names the first thing wrong with it, as a string the client can show", async () => {
    const res = await call(MEMBER, "POST", "/boards/board-one/cards", { title: "" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: unknown };
    assert.equal(typeof body.error, "string");
    assert.match(body.error as string, /^title: /);
  });
});

describe("editing a comment", () => {
  it("is refused once the author has lost the Board", async () => {
    const created = await call(MEMBER, "POST", "/boards/board-one/cards", { title: "A card" });
    const card = (await created.json()) as { id: string };
    const posted = await call(MEMBER, "POST", `/cards/${card.id}/comments`, { body: "first thought" });
    const comment = (await posted.json()) as { id: string };
    await db.delete(schema.boardMembers).where(and(eq(schema.boardMembers.boardId, BOARD), eq(schema.boardMembers.userId, "ada")));

    const res = await call(MEMBER, "PATCH", `/comments/${comment.id}`, { body: "second thought" });
    assert.equal(res.status, 403);
    const row = (await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id)).get())!;
    assert.equal(row.body, "first thought");
  });

  it("still works for a member of the Board", async () => {
    const created = await call(MEMBER, "POST", "/boards/board-one/cards", { title: "A card" });
    const card = (await created.json()) as { id: string };
    const posted = await call(MEMBER, "POST", `/cards/${card.id}/comments`, { body: "first thought" });
    const comment = (await posted.json()) as { id: string };

    const res = await call(MEMBER, "PATCH", `/comments/${comment.id}`, { body: "second thought" });
    assert.equal(res.status, 200);
    const row = (await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id)).get())!;
    assert.equal(row.body, "second thought");
  });
});
