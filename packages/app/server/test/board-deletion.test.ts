import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq, getTableName } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. Dev
// authentication signs the API calls in.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-board-deletion-"));
process.env.KARDBOARD_DATA_DIR = root;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { deleteBoard } = await import("../src/services/board-deletion.js");
const { uploadPath } = await import("../src/services/comments.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ACTOR = { kind: "user" as const, id: "user" };

// Every table that holds a Board's rows, children first, then the User and the Access tokens, which
// belong to no Board.
const TABLES = [
  schema.attachments,
  schema.commentRevisions,
  schema.comments,
  schema.events,
  schema.cards,
  schema.accessTokens,
  schema.users,
  schema.boards,
];

beforeEach(async () => {
  for (const t of TABLES) await db.delete(t);
  fs.rmSync(path.join(root, "uploads"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "backups"), { recursive: true, force: true });
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root" });
  await db.insert(schema.accessTokens).values({ id: "token", name: "Laptop", tokenHash: "hash" });
  await fill("doomed", "Doomed", ["only-here", "shared"]);
  await fill("kept", "Kept", ["shared"]);
});

function writeUpload(sha256: string) {
  fs.mkdirSync(path.dirname(uploadPath(sha256)), { recursive: true });
  fs.writeFileSync(uploadPath(sha256), sha256);
}

// A Board with one of everything that can hang off it, each attachment's file written to disk.
async function fill(id: string, name: string, hashes: string[]) {
  const card = `${id}-card`;
  const comment = `${id}-comment`;
  await db.insert(schema.boards).values({ id, slug: `${id}-board`, name });
  await db.insert(schema.cards).values({ id: card, boardId: id, title: "A card" });
  await db.insert(schema.comments).values({ id: comment, cardId: card, authorKind: "user", authorId: "user", body: "hello" });
  await db.insert(schema.commentRevisions).values({ id: `${id}-revision`, commentId: comment, body: "hullo" });
  for (const sha256 of hashes) {
    await db.insert(schema.attachments).values({ id: `${id}-${sha256}`, commentId: comment, filename: "a.txt", mime: "text/plain", size: 1, sha256 });
    writeUpload(sha256);
  }
  await db.insert(schema.events).values({ id: `${id}-event`, boardId: id, cardId: card, actorKind: "user", actorId: "user", type: "card.created", payload: {} });
}

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await db.select().from(t);
    out[getTableName(t)] = rows.length;
  }
  return out;
}

describe("deleting a board", () => {
  it("removes everything on it and nothing on another board", async () => {
    const res = await call("DELETE", "/admin/boards/doomed", { slug: "doomed-board" });
    assert.equal(res.status, 200);

    assert.equal(await db.select().from(schema.boards).where(eq(schema.boards.id, "doomed")).get(), undefined);
    for (const [table, where] of [
      [schema.cards, eq(schema.cards.boardId, "doomed")],
      [schema.comments, eq(schema.comments.cardId, "doomed-card")],
      [schema.commentRevisions, eq(schema.commentRevisions.commentId, "doomed-comment")],
      [schema.attachments, eq(schema.attachments.commentId, "doomed-comment")],
    ] as const) {
      assert.deepEqual(await db.select().from(table).where(where), [], `${getTableName(table)} kept the deleted board's rows`);
    }

    // Every row of the other Board is still there: one of each.
    const kept = await call("GET", "/admin/boards/kept/deletion");
    assert.deepEqual(await kept.json(), { cards: 1, comments: 1, attachments: 1 });
    assert.equal((await db.select().from(schema.events).where(eq(schema.events.boardId, "kept"))).length, 1);
  });

  // An Access token reaches every Board (ADR 0012), so it outlives any one of them.
  it("leaves the access tokens alone", async () => {
    assert.equal((await call("DELETE", "/admin/boards/doomed", { slug: "doomed-board" })).status, 200);
    const tokens = await db.select().from(schema.accessTokens);
    assert.deepEqual(
      tokens.map((t) => [t.id, t.revokedAt]),
      [["token", null]],
    );
  });

  it("takes a snapshot first and leaves one event naming it", async () => {
    const res = await call("DELETE", "/admin/boards/doomed", { slug: "doomed-board" });
    const { snapshot } = (await res.json()) as { snapshot: string };
    assert.ok(fs.existsSync(path.join(root, "backups", snapshot)), "the snapshot is on disk");
    const events = await db.select().from(schema.events).where(eq(schema.events.boardId, "doomed"));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "board.deleted");
    assert.deepEqual(events[0]!.payload, { name: "Doomed", slug: "doomed-board", cards: 1, snapshot });
  });

  it("removes an uploaded file only when no other board's attachment still uses it", async () => {
    const { uploadsRemoved } = await deleteBoard("doomed", ACTOR);
    assert.equal(await uploadsRemoved, 1);
    assert.equal(fs.existsSync(uploadPath("only-here")), false);
    assert.equal(fs.existsSync(uploadPath("shared")), true);
  });

  it("is refused when no snapshot can be taken, and deletes nothing", async () => {
    const before = await rowCounts();
    await assert.rejects(
      deleteBoard("doomed", ACTOR, () => Promise.reject(new Error("disk full"))),
      (err: Error & { status?: number }) => err.status === 503 && /nothing was deleted: disk full/.test(err.message),
    );
    assert.deepEqual(await rowCounts(), before);
  });

  it("needs the board's slug, typed exactly", async () => {
    const res = await call("DELETE", "/admin/boards/doomed", { slug: "Doomed" });
    assert.equal(res.status, 400);
    assert.ok(await db.select().from(schema.boards).where(eq(schema.boards.id, "doomed")).get());
  });

  it("says what would go, before anything does", async () => {
    const res = await call("GET", "/admin/boards/doomed/deletion");
    assert.deepEqual(await res.json(), { cards: 1, comments: 1, attachments: 2 });
    assert.equal((await call("GET", "/admin/boards/nope/deletion")).status, 404);
  });
});
