import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { Card, Comment, User } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-notifications-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.test";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { listNotifications, markNotificationsRead, notifyCardMoved, notifyMentions } = await import("../src/services/notifications.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const OTHER_BOARD = "board-2";

let n = 0;
async function makeUser(name: string, role: "admin" | "member" = "member"): Promise<User> {
  const id = `user-${n++}`;
  await db.insert(schema.users).values({ id, email: `${id}@example.com`, handle: id, name, role, status: "active" });
  const row = (await db.select().from(schema.users).where(eq(schema.users.id, id)).get())!;
  return { ...row } as User;
}

async function makeCard(boardId: string, creator: User, title = "A card"): Promise<Card> {
  const id = `card-${n++}`;
  await db.insert(schema.cards).values({ id, boardId, title, creatorKind: "user", creatorId: creator.id });
  const row = (await db.select().from(schema.cards).where(eq(schema.cards.id, id)).get())!;
  return { ...row, commentCount: 0, activeSession: null } as Card;
}

function comment(cardId: string, author: User, body: string): Comment {
  return {
    id: `comment-${n++}`,
    cardId,
    authorKind: "user",
    authorId: author.id,
    sessionId: null,
    body,
    editedAt: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    mentions: [],
  };
}

beforeEach(async () => {
  await db.delete(schema.notifications);
  await db.delete(schema.cards);
  await db.delete(schema.boardMembers);
  await db.delete(schema.users);
  await db.delete(schema.boards);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-one", name: "Board one" },
    { id: OTHER_BOARD, slug: "board-two", name: "Board two" },
  ]);
});

async function member(name: string, boardIds: string[] = [BOARD]): Promise<User> {
  const u = await makeUser(name);
  for (const boardId of boardIds) await db.insert(schema.boardMembers).values({ boardId, userId: u.id });
  return u;
}

describe("notifyCardMoved", () => {
  it("tells the creator who moved their card and where", async () => {
    const creator = await member("Ada");
    const mover = await member("Grace");
    const card = await makeCard(BOARD, creator, "Notifications indicator");

    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });

    const view = await listNotifications(creator);
    assert.equal(view.unread, 1);
    assert.equal(view.notifications.length, 1);
    const [only] = view.notifications;
    assert.equal(only!.kind, "card_moved");
    assert.equal(only!.title, "Grace moved your card to Review");
    assert.equal(only!.body, "Inbox → Review");
    assert.equal(only!.actorName, "Grace");
    assert.equal(only!.cardTitle, "Notifications indicator");
    assert.equal(only!.cardId, card.id);
    assert.equal(only!.boardSlug, "board-one");
    assert.equal(only!.readAt, null);
  });

  it("stays quiet when the creator moved the card themselves", async () => {
    const creator = await member("Ada");
    const card = await makeCard(BOARD, creator);

    await notifyCardMoved({ ...card, column: "done" }, "review", { kind: "user", id: creator.id });

    assert.deepEqual(await listNotifications(creator), { unread: 0, notifications: [] });
  });

  it("stays quiet for a revoked creator", async () => {
    const creator = await member("Ada");
    const mover = await member("Grace");
    await db.update(schema.users).set({ status: "revoked" }).where(eq(schema.users.id, creator.id));
    const card = await makeCard(BOARD, creator);

    await notifyCardMoved({ ...card, column: "done" }, "review", { kind: "user", id: mover.id });

    assert.equal((await listNotifications(creator)).notifications.length, 0);
  });
});

describe("notifyMentions", () => {
  it("notifies each newly mentioned user once and records a preview of the comment", async () => {
    const author = await member("Grace");
    const ada = await member("Ada");
    const linus = await member("Linus");
    const card = await makeCard(BOARD, author, "Enter key in the comment box");
    const c = comment(card.id, author, `@${ada.handle} @${linus.handle} have a look`);
    await db.insert(schema.comments).values({ id: c.id, cardId: card.id, authorKind: "user", authorId: author.id, body: c.body });

    await notifyMentions(card, c, [ada.id, linus.id], { kind: "user", id: author.id });

    for (const u of [ada, linus]) {
      const view = await listNotifications(u);
      assert.equal(view.unread, 1);
      assert.equal(view.notifications[0]!.kind, "mention");
      assert.equal(view.notifications[0]!.title, "Grace mentioned you");
      assert.equal(view.notifications[0]!.body, c.body);
      assert.equal(view.notifications[0]!.cardTitle, "Enter key in the comment box");
    }
    assert.equal((await listNotifications(author)).notifications.length, 0);
  });

  it("truncates a long comment to a preview", async () => {
    const author = await member("Grace");
    const ada = await member("Ada");
    const card = await makeCard(BOARD, author);
    const c = comment(card.id, author, "x".repeat(2000));
    await db.insert(schema.comments).values({ id: c.id, cardId: card.id, authorKind: "user", authorId: author.id, body: c.body });

    await notifyMentions(card, c, [ada.id], { kind: "user", id: author.id });

    assert.equal((await listNotifications(ada)).notifications[0]!.body.length, 500);
  });

  it("does nothing when nobody was newly mentioned", async () => {
    const author = await member("Grace");
    const ada = await member("Ada");
    const card = await makeCard(BOARD, author);

    await notifyMentions(card, comment(card.id, author, "no handles here"), [], { kind: "user", id: author.id });

    assert.equal((await listNotifications(ada)).unread, 0);
  });
});

describe("markNotificationsRead", () => {
  async function three(): Promise<{ ada: User; ids: string[] }> {
    const ada = await member("Ada");
    const mover = await member("Grace");
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      const card = await makeCard(BOARD, ada, title);
      await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });
    }
    for (const notification of (await listNotifications(ada)).notifications) ids.push(notification.id);
    return { ada, ids };
  }

  it("marks only the named notification", async () => {
    const { ada, ids } = await three();
    const view = await markNotificationsRead(ada, [ids[0]!]);
    assert.equal(view.unread, 2);
    assert.equal(view.notifications.find((x) => x.id === ids[0])!.readAt !== null, true);
    assert.equal(view.notifications.find((x) => x.id === ids[1])!.readAt, null);
  });

  it("marks everything read when given no ids", async () => {
    const { ada } = await three();
    const view = await markNotificationsRead(ada);
    assert.equal(view.unread, 0);
    assert.equal(view.notifications.every((x) => x.readAt !== null), true);
  });

  it("leaves another user's notification alone", async () => {
    const { ids } = await three();
    const mallory = await member("Mallory");
    await markNotificationsRead(mallory, ids);
    const row = (await db.select().from(schema.notifications).where(eq(schema.notifications.id, ids[0]!)).get())!;
    assert.equal(row.readAt, null);
  });
});

describe("board access", () => {
  it("hides a notification from a member who has lost the board", async () => {
    const ada = await member("Ada");
    const mover = await member("Grace");
    const card = await makeCard(BOARD, ada);
    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });
    assert.equal((await listNotifications(ada)).unread, 1);

    await db.delete(schema.boardMembers).where(eq(schema.boardMembers.userId, ada.id));

    assert.deepEqual(await listNotifications(ada), { unread: 0, notifications: [] });
  });

  it("shows an admin their notifications without a board membership", async () => {
    const admin = await makeUser("Root", "admin");
    const mover = await member("Grace");
    const card = await makeCard(BOARD, admin);
    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });

    assert.equal((await listNotifications(admin)).unread, 1);
  });
});

describe("deleting a card", () => {
  it("takes its notifications with it", async () => {
    const ada = await member("Ada");
    const mover = await member("Grace");
    const card = await makeCard(BOARD, ada);
    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });

    await db.delete(schema.cards).where(eq(schema.cards.id, card.id));

    assert.deepEqual(await listNotifications(ada), { unread: 0, notifications: [] });
  });
});
