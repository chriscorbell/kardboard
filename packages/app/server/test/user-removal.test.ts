import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. Dev
// authentication signs the API calls in, `X-Dev-User` picking the caller by email.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-user-removal-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { activateFromClerk, inviteUser } = await import("../src/services/users.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ADMIN = "root@example.com";

beforeEach(async () => {
  for (const t of [schema.previewCodes, schema.previews, schema.notifications, schema.outboundEmails, schema.mentions, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: "board-1", slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada Lovelace", role: "member", status: "revoked", clerkUserId: "clerk_ada", avatarUrl: "https://img.example/ada.png" },
  ]);
  await db.insert(schema.boardMembers).values({ boardId: "board-1", userId: "ada" });
  await db.insert(schema.cards).values({ id: "card-1", boardId: "board-1", title: "A card", creatorKind: "user", creatorId: "ada" });
  await db.insert(schema.comments).values({ id: "comment-1", cardId: "card-1", authorKind: "user", authorId: "ada", body: "hello @root" });
  await db.insert(schema.notifications).values({ id: "n-1", userId: "ada", boardId: "board-1", cardId: "card-1", kind: "mention", title: "t", actorName: "Root" });
  await db.insert(schema.outboundEmails).values([
    { id: "pending", toUserId: "ada", subject: "s", html: "h", status: "pending" },
    { id: "sent", toUserId: "ada", subject: "s", html: "h", status: "sent" },
  ]);
  await db.insert(schema.previews).values({ id: "preview-1", boardId: "board-1", cardId: "card-1", host: "card-1.kardboard.cc", branch: "b" });
  await db.insert(schema.previewCodes).values({ code: "code-1", previewId: "preview-1", userId: "ada", expiresAt: new Date(Date.now() + 60_000).toISOString() });
});

function call(method: string, url: string, as = ADMIN) {
  return api.request(url, { method, headers: { "x-dev-user": as } });
}

const ada = () => db.select().from(schema.users).where(eq(schema.users.id, "ada")).get();

describe("removing a user", () => {
  it("deletes their account and everything addressed to them, and keeps their name on what they wrote", async () => {
    const res = await call("DELETE", "/admin/users/ada");
    assert.equal(res.status, 200);

    const row = (await ada())!;
    assert.ok(row.removedAt);
    assert.equal(row.status, "revoked");
    assert.equal(row.name, "Ada Lovelace");
    assert.equal(row.handle, "ada");
    assert.equal(row.email, "removed-ada@removed.invalid");
    assert.equal(row.clerkUserId, null);
    assert.equal(row.avatarUrl, null);

    assert.deepEqual(await db.select().from(schema.boardMembers).where(eq(schema.boardMembers.userId, "ada")), []);
    assert.deepEqual(await db.select().from(schema.notifications).where(eq(schema.notifications.userId, "ada")), []);
    assert.deepEqual(await db.select().from(schema.previewCodes).where(eq(schema.previewCodes.userId, "ada")), []);
    assert.deepEqual((await db.select().from(schema.outboundEmails)).map((e) => e.id), ["sent"]);

    // Their Card and Comment stay, and the Board still names them.
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.authorId, "ada"))).length, 1);
    const board = (await (await call("GET", "/boards/board-one")).json()) as { people: { id: string; name: string }[] };
    assert.deepEqual(
      board.people.find((p) => p.id === "ada"),
      { id: "ada", handle: "ada", name: "Ada Lovelace", avatarUrl: null },
    );
  });

  it("takes them off the Users list", async () => {
    await call("DELETE", "/admin/users/ada");
    const users = (await (await call("GET", "/admin/users")).json()) as { id: string }[];
    assert.deepEqual(
      users.map((u) => u.id),
      ["admin"],
    );
  });

  it("is refused for someone whose access has not been revoked, and for yourself", async () => {
    await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, "ada"));
    const active = await call("DELETE", "/admin/users/ada");
    assert.equal(active.status, 409);
    assert.match(((await active.json()) as { error: string }).error, /Revoke their access first/);
    assert.equal((await ada())!.removedAt, null);

    assert.equal((await call("DELETE", "/admin/users/admin")).status, 400);
  });

  it("is the Admin's alone", async () => {
    await db.insert(schema.users).values({ id: "bob", email: "bob@example.com", handle: "bob", name: "Bob", role: "member", status: "active" });
    assert.equal((await call("DELETE", "/admin/users/ada", "bob@example.com")).status, 403);
    assert.equal((await ada())!.removedAt, null);
  });

  it("cannot be undone by reinstating, and a second removal finds no one", async () => {
    await call("DELETE", "/admin/users/ada");
    assert.equal((await call("POST", "/admin/users/ada/reinstate")).status, 404);
    assert.equal((await call("POST", "/admin/users/ada/resend-invitation")).status, 404);
    assert.equal((await ada())!.status, "revoked");
    assert.equal((await call("DELETE", "/admin/users/ada")).status, 404);
  });

  it("frees the address for a new invitation, as someone new with a handle of their own", async () => {
    await call("DELETE", "/admin/users/ada");
    const fresh = await inviteUser({ email: "ada@example.com", name: "Ada Again", role: "member" });
    assert.notEqual(fresh.id, "ada");
    assert.equal(fresh.status, "invited");
    assert.equal(fresh.handle, "ada2", "the old handle still names the removed Ada in old Mentions");
  });

  it("stops their old sign-in from reaching the account", async () => {
    await call("DELETE", "/admin/users/ada");
    assert.equal(await activateFromClerk({ clerkUserId: "clerk_ada", email: "ada@example.com", name: "Ada", avatarUrl: null }), null);
  });
});
