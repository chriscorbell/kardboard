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
const { emailWanted, listNotifications, markCardNotificationsRead, markNotificationsRead, notifyCardMoved, notifyMentions } = await import("../src/services/notifications.js");
const { createComment } = await import("../src/services/comments.js");
const { getAgentProfile } = await import("../src/services/settings.js");

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
      // The bell reads as the card does: people by name, not by handle.
      assert.equal(view.notifications[0]!.body, "@Ada @Linus have a look");
      assert.equal(view.notifications[0]!.cardTitle, "Enter key in the comment box");
    }
    assert.equal((await listNotifications(author)).notifications.length, 0);
  });

  it("names the Agent too, and leaves code and unknown handles as written", async () => {
    const author = await member("Grace");
    const ada = await member("Ada");
    const card = await makeCard(BOARD, author);
    const agent = (await getAgentProfile()).name;
    const c = comment(card.id, author, `@${ada.handle}, @${agent.toLowerCase()} says run \`@${ada.handle}/pkg\`; ask @nobody`);
    await db.insert(schema.comments).values({ id: c.id, cardId: card.id, authorKind: "user", authorId: author.id, body: c.body });

    await notifyMentions(card, c, [ada.id], { kind: "user", id: author.id });

    assert.equal((await listNotifications(ada)).notifications[0]!.body, `@Ada, @${agent} says run \`@${ada.handle}/pkg\`; ask @nobody`);
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

describe("who hears about a card", () => {
  async function emailsTo(user: User): Promise<number> {
    return (await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.toUserId, user.id))).length;
  }

  it("records a Mention only for someone who can open the card", async () => {
    const author = await member("Grace");
    const ada = await member("Ada");
    const outsider = await member("Mallory", [OTHER_BOARD]);
    const gone = await member("Linus");
    await db.update(schema.users).set({ status: "revoked" }).where(eq(schema.users.id, gone.id));
    const admin = await makeUser("Root", "admin");
    const card = await makeCard(BOARD, author);

    const c = await createComment({ cardId: card.id, body: `@${ada.handle} @${outsider.handle} @${gone.handle} @${admin.handle} over to you`, actor: { kind: "agent", id: null } });

    assert.deepEqual([...c.mentions].sort(), [ada.id, admin.id].sort());
    assert.equal((await listNotifications(ada)).unread, 1);
    assert.equal((await listNotifications(admin)).unread, 1, "the Admin can open every Board");
    assert.equal(await emailsTo(outsider), 0, "a handle on another Board is not a way in");
    assert.equal(await emailsTo(gone), 0);
  });

  it("sends nothing to a mentioned user who is not on the Board, even when asked directly", async () => {
    const author = await member("Grace");
    const outsider = await member("Mallory", [OTHER_BOARD]);
    const card = await makeCard(BOARD, author);

    await notifyMentions(card, comment(card.id, author, `@${outsider.handle}`), [outsider.id], { kind: "user", id: author.id });

    assert.equal(await emailsTo(outsider), 0);
    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.userId, outsider.id))).length, 0);
  });

  it("does not tell a creator who has lost the Board that their card moved", async () => {
    const creator = await member("Ada");
    const mover = await member("Grace");
    const card = await makeCard(BOARD, creator);
    await db.delete(schema.boardMembers).where(eq(schema.boardMembers.userId, creator.id));

    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: mover.id });

    assert.equal(await emailsTo(creator), 0);
    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.userId, creator.id))).length, 0);
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

describe("which moves are worth a notification", () => {
  it("tells the creator only about moves into Blocked, Review, or Done", async () => {
    const creator = await member("Ada");
    const card = await makeCard(BOARD, creator);
    for (const to of ["ready", "in_progress", "inbox", "blocked", "review", "done"] as const) {
      await notifyCardMoved({ ...card, column: to }, "inbox", { kind: "agent", id: null });
    }
    const titles = (await listNotifications(creator)).notifications.map((x) => x.title).sort();
    assert.deepEqual(titles, ["Milo moved your card to Blocked", "Milo moved your card to Done", "Milo moved your card to Review"]);
  });
});

describe("email preferences", () => {
  async function emailSubjects(user: User): Promise<string[]> {
    return (await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.toUserId, user.id))).map((e) => e.subject).sort();
  }
  async function prefer(user: User, emailPreference: "all" | "important" | "off") {
    await db.update(schema.users).set({ emailPreference }).where(eq(schema.users.id, user.id));
  }

  it("decides by kind, and by where a moved card went", () => {
    for (const kind of ["mention", "session_failed", "card_moved"]) {
      assert.equal(emailWanted("all", { kind, column: "done" }), true);
      assert.equal(emailWanted("off", { kind, column: "blocked" }), false);
    }
    assert.equal(emailWanted("important", { kind: "mention", column: "done" }), true);
    assert.equal(emailWanted("important", { kind: "session_failed", column: "in_progress" }), true);
    assert.equal(emailWanted("important", { kind: "card_moved", column: "blocked" }), true);
    assert.equal(emailWanted("important", { kind: "card_moved", column: "review" }), true);
    assert.equal(emailWanted("important", { kind: "card_moved", column: "done" }), false);
    assert.equal(emailWanted("important", { kind: "something_new", column: "review" }), false);
  });

  it("still records every notification in the bell when email is off", async () => {
    const creator = await member("Ada");
    const author = await member("Grace");
    await prefer(creator, "off");
    const card = await makeCard(BOARD, creator, "Quiet card");

    await notifyCardMoved({ ...card, column: "review" }, "inbox", { kind: "user", id: author.id });
    const c = comment(card.id, author, `@${creator.handle} look`);
    await db.insert(schema.comments).values({ id: c.id, cardId: card.id, authorKind: "user", authorId: author.id, body: c.body });
    await notifyMentions(card, c, [creator.id], { kind: "user", id: author.id });

    assert.equal((await listNotifications(creator)).unread, 2);
    assert.deepEqual(await emailSubjects(creator), []);
  });

  it("emails only what asks something of the reader when set to important", async () => {
    const creator = await member("Ada");
    const author = await member("Grace");
    await prefer(creator, "important");
    const card = await makeCard(BOARD, creator, "Pick a colour");

    await notifyCardMoved({ ...card, column: "blocked" }, "inbox", { kind: "agent", id: null });
    await notifyCardMoved({ ...card, column: "review" }, "blocked", { kind: "agent", id: null });
    await notifyCardMoved({ ...card, column: "done" }, "review", { kind: "user", id: author.id });
    const c = comment(card.id, author, `@${creator.handle} thanks`);
    await db.insert(schema.comments).values({ id: c.id, cardId: card.id, authorKind: "user", authorId: author.id, body: c.body });
    await notifyMentions(card, c, [creator.id], { kind: "user", id: author.id });

    assert.equal((await listNotifications(creator)).unread, 4);
    assert.deepEqual(await emailSubjects(creator), ['"Pick a colour" moved to Blocked', '"Pick a colour" moved to Review', 'Grace mentioned you on "Pick a colour"'].sort());
  });

  it("emails everything by default", async () => {
    const creator = await member("Ada");
    const card = await makeCard(BOARD, creator, "Ship it");

    await notifyCardMoved({ ...card, column: "done" }, "review", { kind: "agent", id: null });

    assert.deepEqual(await emailSubjects(creator), ['"Ship it" moved to Done']);
  });
});

describe("markCardNotificationsRead", () => {
  it("marks the opened card's notifications read, and nothing else", async () => {
    const ada = await member("Ada");
    const grace = await member("Grace");
    const opened = await makeCard(BOARD, ada, "opened");
    const other = await makeCard(BOARD, ada, "other");
    const gracesCard = await makeCard(BOARD, grace, "hers");
    await notifyCardMoved({ ...opened, column: "review" }, "inbox", { kind: "agent", id: null });
    await notifyCardMoved({ ...opened, column: "blocked" }, "review", { kind: "agent", id: null });
    await notifyCardMoved({ ...other, column: "review" }, "inbox", { kind: "agent", id: null });
    await notifyCardMoved({ ...gracesCard, column: "review" }, "inbox", { kind: "agent", id: null });

    const view = await markCardNotificationsRead(ada, opened.id);

    assert.equal(view.unread, 1);
    assert.deepEqual(view.notifications.filter((x) => x.readAt === null).map((x) => x.cardTitle), ["other"]);
    assert.equal((await listNotifications(grace)).unread, 1);
  });
});
