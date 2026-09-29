import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

// Deleting a Card through the REST API, the way the card sheet does. Dev authentication picks the
// caller by email; Triggers are held back so a stray one would show as a row.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-card-deletion-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const ADMIN = "root@example.com";
const ADA = "ada@example.com";
const BEA = "bea@example.com";

beforeEach(async () => {
  for (const t of [schema.sessions, schema.triggers, schema.events, schema.notifications, schema.attachments, schema.comments, schema.approvals, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  fs.rmSync(path.join(root, "uploads"), { recursive: true, force: true });
  await db.insert(schema.boards).values({ sessionsEnabled: true, id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: ADA, handle: "ada", name: "Ada", role: "member", status: "active" },
    { id: "bea", email: BEA, handle: "bea", name: "Bea", role: "member", status: "active" },
  ]);
  await db.insert(schema.boardMembers).values([
    { boardId: BOARD, userId: "ada" },
    { boardId: BOARD, userId: "bea" },
  ]);
});

function del(as: string, cardId: string) {
  return api.request(`/cards/${cardId}`, { method: "DELETE", headers: { "x-dev-user": as } });
}

async function card(id: string, values: Partial<typeof schema.cards.$inferInsert> = {}) {
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column: "ready", creatorKind: "user", creatorId: "ada", ...values });
}

const exists = async (id: string) => Boolean(await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get());

// An uploaded file on disk and the Attachment that points at it, on a Comment of the Card.
function upload(bytes: string): string {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(root, "uploads", sha256.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sha256), bytes);
  return sha256;
}
const onDisk = (sha256: string) => fs.existsSync(path.join(root, "uploads", sha256.slice(0, 2), sha256));

describe("who may delete a card", () => {
  it("lets its creator delete it", async () => {
    await card("mine");
    assert.equal((await del(ADA, "mine")).status, 204);
    assert.equal(await exists("mine"), false);
  });

  it("refuses another member", async () => {
    await card("adas");
    const res = await del(BEA, "adas");
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /Admin, or the person who created/);
    assert.equal(await exists("adas"), true);
  });

  it("leaves the Agent's cards to the Admin", async () => {
    await card("agents", { creatorKind: "agent", creatorId: null });
    assert.equal((await del(ADA, "agents")).status, 403);
    assert.equal((await del(ADMIN, "agents")).status, 204);
  });

  it("refuses while a session works on the card", async () => {
    await card("busy");
    await db.insert(schema.sessions).values({ id: "s1", boardId: BOARD, cardId: "busy", kind: "card", provider: "claude", status: "running" });
    const res = await del(ADMIN, "busy");
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /working on this card/);
    assert.equal(await exists("busy"), true);
  });
});

describe("deleting a card", () => {
  it("takes what the card said with it, and records only who deleted it", async () => {
    await card("doomed", { parentCardId: null });
    await db.insert(schema.comments).values({ id: "c1", cardId: "doomed", authorKind: "user", authorId: "ada", body: "the secret is hunter2" });
    const shared = upload("shared bytes");
    const own = upload("own bytes");
    await db.insert(schema.attachments).values([
      { id: "a1", commentId: "c1", filename: "shared.txt", mime: "text/plain", size: 12, sha256: shared },
      { id: "a2", commentId: "c1", filename: "own.txt", mime: "text/plain", size: 9, sha256: own },
    ]);
    // The same file also attached on another card, which keeps it on disk.
    await card("other");
    await db.insert(schema.comments).values({ id: "c2", cardId: "other", authorKind: "user", authorId: "ada", body: "same file" });
    await db.insert(schema.attachments).values({ id: "a3", commentId: "c2", filename: "shared.txt", mime: "text/plain", size: 12, sha256: shared });
    await db.insert(schema.triggers).values({ id: "t1", boardId: BOARD, cardId: "doomed", kind: "comment_posted", actorUserId: "ada", payload: {} });
    await db.insert(schema.events).values({ id: "e1", boardId: BOARD, cardId: "doomed", actorKind: "user", actorId: "ada", type: "card.edited", payload: { previous: { description: "the secret is hunter2" } } });

    assert.equal((await del(ADA, "doomed")).status, 204);

    assert.deepEqual(await db.select().from(schema.comments).where(eq(schema.comments.cardId, "doomed")), []);
    assert.deepEqual((await db.select().from(schema.attachments)).map((a) => a.id), ["a3"]);
    assert.equal(onDisk(own), false, "a file nothing else points at is removed");
    assert.equal(onDisk(shared), true, "a file another card still uses stays");
    assert.deepEqual(await db.select().from(schema.triggers), []);
    const events = await db.select().from(schema.events).where(eq(schema.events.cardId, "doomed"));
    assert.deepEqual(
      events.map((e) => [e.type, e.actorId]),
      [["card.deleted", "ada"]],
    );
    assert.doesNotMatch(JSON.stringify(events), /hunter2|Card doomed/);
  });

  it("leaves its children standing without a parent", async () => {
    await card("parent", { column: "blocked" });
    await card("child", { parentCardId: "parent", creatorKind: "agent", creatorId: null });
    assert.equal((await del(ADMIN, "parent")).status, 204);
    const child = (await db.select().from(schema.cards).where(eq(schema.cards.id, "child")).get())!;
    assert.equal(child.parentCardId, null);
  });

  it("wakes a parent whose last open child it was", async () => {
    await card("parent", { column: "blocked" });
    await card("finished", { parentCardId: "parent", column: "done", outcome: "implemented", creatorKind: "agent", creatorId: null });
    await card("dropped", { parentCardId: "parent", creatorKind: "agent", creatorId: null });
    assert.equal((await del(ADMIN, "dropped")).status, 204);
    assert.equal((await db.select().from(schema.cards).where(eq(schema.cards.id, "parent")).get())!.column, "ready");
  });
});
