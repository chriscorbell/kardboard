import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq, getTableName } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. Dev
// authentication signs the API calls in; a runner URL puts the client in http mode, whose preview
// removal the tests replace.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-board-deletion-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_RUNNER_URL = "http://runner.test";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { deleteBoard } = await import("../src/services/board-deletion.js");
const { takeSnapshot } = await import("../src/services/backup.js");
const { uploadPath } = await import("../src/services/comments.js");
const { runner } = await import("../src/services/runner-client.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

let stoppedPreviews: string[] = [];
runner.stopPreview = async (id) => {
  stoppedPreviews.push(id);
};

const ADMIN = "root@example.com";
const MEMBER = "ada@example.com";
const ACTOR = { kind: "user" as const, id: "admin" };

// Every table that holds a Board's rows, children first.
const TABLES = [
  schema.previewCodes,
  schema.previews,
  schema.notifications,
  schema.mentions,
  schema.attachments,
  schema.commentRevisions,
  schema.outboundEmails,
  schema.comments,
  schema.approvals,
  schema.triggers,
  schema.sessions,
  schema.events,
  schema.cards,
  schema.boardMembers,
  schema.users,
  schema.boards,
];

beforeEach(async () => {
  for (const t of TABLES) await db.delete(t);
  fs.rmSync(path.join(root, "uploads"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "backups"), { recursive: true, force: true });
  stoppedPreviews = [];
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
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
  const preview = `${id}-preview`;
  await db.insert(schema.boards).values({ id, slug: `${id}-board`, name });
  await db.insert(schema.boardMembers).values({ boardId: id, userId: "ada" });
  await db.insert(schema.cards).values({ id: card, boardId: id, title: "A card" });
  await db.insert(schema.comments).values({ id: comment, cardId: card, authorKind: "user", authorId: "ada", body: "hello @root" });
  await db.insert(schema.commentRevisions).values({ id: `${id}-revision`, commentId: comment, body: "hullo" });
  await db.insert(schema.mentions).values({ commentId: comment, userId: "admin" });
  for (const sha256 of hashes) {
    await db.insert(schema.attachments).values({ id: `${id}-${sha256}`, commentId: comment, filename: "a.txt", mime: "text/plain", size: 1, sha256 });
    writeUpload(sha256);
  }
  await db.insert(schema.approvals).values({ id: `${id}-approval`, cardId: card, userId: "admin" });
  await db.insert(schema.notifications).values({ id: `${id}-notification`, userId: "admin", boardId: id, cardId: card, kind: "mention", title: "t", actorName: "Ada", commentId: comment });
  await db.insert(schema.outboundEmails).values([
    { id: `${id}-pending`, toUserId: "admin", commentId: comment, subject: "s", html: "h", status: "pending" },
    { id: `${id}-sent`, toUserId: "admin", commentId: comment, subject: "s", html: "h", status: "sent" },
  ]);
  await db.insert(schema.triggers).values({ id: `${id}-trigger`, boardId: id, cardId: card, kind: "comment_posted", payload: {} });
  await db.insert(schema.sessions).values({ id: `${id}-session`, boardId: id, cardId: card, provider: "claude", status: "succeeded" });
  await db.insert(schema.events).values({ id: `${id}-event`, boardId: id, cardId: card, actorKind: "user", actorId: "ada", type: "card.created", payload: {} });
  await db.insert(schema.previews).values({ id: preview, boardId: id, cardId: card, host: `${id}.kardboard.cc`, branch: "b" });
  await db.insert(schema.previewCodes).values({ code: `${id}-code`, previewId: preview, userId: "ada", expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

function call(as: string, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    const res = await call(ADMIN, "DELETE", "/admin/boards/doomed", { slug: "doomed-board" });
    assert.equal(res.status, 200);

    assert.equal(await db.select().from(schema.boards).where(eq(schema.boards.id, "doomed")).get(), undefined);
    for (const [table, where] of [
      [schema.cards, eq(schema.cards.boardId, "doomed")],
      [schema.comments, eq(schema.comments.cardId, "doomed-card")],
      [schema.commentRevisions, eq(schema.commentRevisions.commentId, "doomed-comment")],
      [schema.mentions, eq(schema.mentions.commentId, "doomed-comment")],
      [schema.attachments, eq(schema.attachments.commentId, "doomed-comment")],
      [schema.approvals, eq(schema.approvals.cardId, "doomed-card")],
      [schema.notifications, eq(schema.notifications.boardId, "doomed")],
      [schema.triggers, eq(schema.triggers.boardId, "doomed")],
      [schema.sessions, eq(schema.sessions.boardId, "doomed")],
      [schema.previews, eq(schema.previews.boardId, "doomed")],
      [schema.previewCodes, eq(schema.previewCodes.previewId, "doomed-preview")],
      [schema.boardMembers, eq(schema.boardMembers.boardId, "doomed")],
    ] as const) {
      assert.deepEqual(await db.select().from(table).where(where), [], `${getTableName(table)} kept the deleted board's rows`);
    }

    // Every row of the other Board is still there: one of each, two emails, two attachments less one.
    const kept = await call(ADMIN, "GET", "/admin/boards/kept/deletion");
    assert.deepEqual(await kept.json(), { cards: 1, comments: 1, attachments: 1, previews: 1, activeSessions: 0 });
    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.boardId, "kept"))).length, 1);
    assert.equal((await db.select().from(schema.triggers).where(eq(schema.triggers.boardId, "kept"))).length, 1);
    assert.equal((await db.select().from(schema.boardMembers).where(eq(schema.boardMembers.boardId, "kept"))).length, 1);

    // A sent email stays on the record; one still waiting is not sent.
    const emails = (await db.select().from(schema.outboundEmails)).map((e) => e.id).sort();
    assert.deepEqual(emails, ["doomed-sent", "kept-pending", "kept-sent"]);

    assert.deepEqual(stoppedPreviews, ["doomed-preview"]);
  });

  it("takes a snapshot first and leaves one event naming it", async () => {
    const res = await call(ADMIN, "DELETE", "/admin/boards/doomed", { slug: "doomed-board" });
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

  it("is refused while a session is active, before any snapshot", async () => {
    await db.update(schema.sessions).set({ status: "running" }).where(eq(schema.sessions.id, "doomed-session"));
    const before = await rowCounts();
    let snapshots = 0;
    await assert.rejects(
      deleteBoard("doomed", ACTOR, () => {
        snapshots++;
        return takeSnapshot();
      }),
      (err: Error & { status?: number }) => err.status === 409 && /still running/.test(err.message),
    );
    assert.equal(snapshots, 0);
    assert.deepEqual(await rowCounts(), before);

    const res = await call(ADMIN, "DELETE", "/admin/boards/doomed", { slug: "doomed-board" });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /Cancel it in Sessions/);
  });

  it("is refused when no snapshot can be taken, and deletes nothing", async () => {
    const before = await rowCounts();
    await assert.rejects(
      deleteBoard("doomed", ACTOR, () => Promise.reject(new Error("disk full"))),
      (err: Error & { status?: number }) => err.status === 503 && /nothing was deleted: disk full/.test(err.message),
    );
    assert.deepEqual(await rowCounts(), before);
    assert.deepEqual(stoppedPreviews, []);
  });

  it("needs the board's slug, typed exactly", async () => {
    const res = await call(ADMIN, "DELETE", "/admin/boards/doomed", { slug: "Doomed" });
    assert.equal(res.status, 400);
    assert.ok(await db.select().from(schema.boards).where(eq(schema.boards.id, "doomed")).get());
  });

  it("is the Admin's alone", async () => {
    assert.equal((await call(MEMBER, "DELETE", "/admin/boards/doomed", { slug: "doomed-board" })).status, 403);
    assert.equal((await call(MEMBER, "GET", "/admin/boards/doomed/deletion")).status, 403);
    assert.ok(await db.select().from(schema.boards).where(eq(schema.boards.id, "doomed")).get());
  });

  it("says what would go, before anything does", async () => {
    await db.update(schema.sessions).set({ status: "queued" }).where(eq(schema.sessions.id, "doomed-session"));
    const res = await call(ADMIN, "GET", "/admin/boards/doomed/deletion");
    assert.deepEqual(await res.json(), { cards: 1, comments: 1, attachments: 2, previews: 1, activeSessions: 1 });
    assert.equal((await call(ADMIN, "GET", "/admin/boards/nope/deletion")).status, 404);
  });
});
