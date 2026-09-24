import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { BoardView, Card, Comment, Me } from "@kardboard/shared";

// What a Member sees of a Board and of themselves: who the Board names, which Cards are waiting on
// an answer, deleting a Comment, and their own settings. Dev authentication signs the tests in, and
// `X-Dev-User` picks the caller by email.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-member-view-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { createComment } = await import("../src/services/comments.js");
const { getCard, moveCard } = await import("../src/services/cards.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const ADMIN = "root@example.com";
const MEMBER = "ada@example.com";
const OTHER = "grace@example.com";
const AGENT = { kind: "agent" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.notifications, schema.triggers, schema.events, schema.approvals, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" },
    { id: "grace", email: OTHER, handle: "grace", name: "Grace", role: "member", status: "active" },
  ]);
  await db.insert(schema.boardMembers).values([
    { boardId: BOARD, userId: "ada" },
    { boardId: BOARD, userId: "grace" },
  ]);
});

function call(as: string, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newCard(as = MEMBER, title = "A card"): Promise<Card> {
  const res = await call(as, "POST", "/boards/board-one/cards", { title });
  assert.equal(res.status, 201);
  return (await res.json()) as Card;
}

async function post(as: string, cardId: string, body: string): Promise<Comment> {
  const res = await call(as, "POST", `/cards/${cardId}/comments`, { body });
  assert.equal(res.status, 201);
  return (await res.json()) as Comment;
}

async function upload(as: string, commentId: string, name: string, text: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  return api.request(`/comments/${commentId}/attachments`, { method: "POST", headers: { "x-dev-user": as }, body: form });
}

async function boardView(as = MEMBER): Promise<BoardView> {
  const res = await call(as, "GET", "/boards/board-one");
  assert.equal(res.status, 200);
  return (await res.json()) as BoardView;
}

async function triggerKinds(cardId: string): Promise<string[]> {
  return (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, cardId))).map((t) => t.kind).sort();
}

function uploadExists(sha256: string): boolean {
  return fs.existsSync(path.join(root, "uploads", sha256.slice(0, 2), sha256));
}

describe("deleting a comment", () => {
  it("removes it with its revisions, mentions, and attachments, records who, and starts nothing", async () => {
    const card = await newCard();
    const comment = await post(MEMBER, card.id, "the password is hunter2, @grace");
    assert.equal((await call(MEMBER, "PATCH", `/comments/${comment.id}`, { body: "the password is hunter3, @grace" })).status, 200);
    assert.equal((await upload(MEMBER, comment.id, "secret.txt", "hunter2")).status, 201);
    const before = await triggerKinds(card.id);

    const res = await call(MEMBER, "DELETE", `/comments/${comment.id}`);

    assert.equal(res.status, 204);
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id))).length, 0);
    assert.equal((await db.select().from(schema.commentRevisions).where(eq(schema.commentRevisions.commentId, comment.id))).length, 0);
    assert.equal((await db.select().from(schema.attachments).where(eq(schema.attachments.commentId, comment.id))).length, 0);
    assert.equal((await db.select().from(schema.mentions).where(eq(schema.mentions.commentId, comment.id))).length, 0);
    const deleted = (await db.select().from(schema.events).where(and(eq(schema.events.cardId, card.id), eq(schema.events.type, "comment.deleted"))))[0]!;
    assert.deepEqual(deleted.payload, { commentId: comment.id, authorKind: "user", authorId: "ada" });
    assert.equal(deleted.actorId, "ada");
    assert.equal(JSON.stringify(deleted.payload).includes("hunter"), false);
    assert.deepEqual(await triggerKinds(card.id), before, "taking a comment back is not a request for work");
    assert.equal((await getCard(card.id))!.commentCount, 0);
  });

  it("takes the mention notification that quoted it", async () => {
    const card = await newCard();
    const comment = await post(MEMBER, card.id, "@grace the key is abc123");
    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.userId, "grace"))).length, 1);

    await call(MEMBER, "DELETE", `/comments/${comment.id}`);

    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.userId, "grace"))).length, 0);
  });

  it("removes an uploaded file only once no other attachment uses it", async () => {
    const card = await newCard();
    const first = await post(MEMBER, card.id, "screenshot");
    const second = await post(MEMBER, card.id, "same screenshot again");
    const att = (await (await upload(MEMBER, first.id, "a.txt", "same bytes")).json()) as { id: string };
    await upload(MEMBER, second.id, "b.txt", "same bytes");
    const sha256 = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get())!.sha256;
    assert.equal(uploadExists(sha256), true);

    await call(MEMBER, "DELETE", `/comments/${first.id}`);
    assert.equal(uploadExists(sha256), true, "the second comment still shows it");

    await call(MEMBER, "DELETE", `/comments/${second.id}`);
    assert.equal(uploadExists(sha256), false);
  });

  it("is refused to another Member", async () => {
    const card = await newCard();
    const comment = await post(MEMBER, card.id, "mine");
    assert.equal((await call(OTHER, "DELETE", `/comments/${comment.id}`)).status, 403);
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id))).length, 1);
  });

  it("is refused to an author who has lost the Board", async () => {
    const card = await newCard();
    const comment = await post(MEMBER, card.id, "mine");
    await db.delete(schema.boardMembers).where(eq(schema.boardMembers.userId, "ada"));
    assert.equal((await call(MEMBER, "DELETE", `/comments/${comment.id}`)).status, 403);
  });

  it("lets only the Admin remove the Agent's comment", async () => {
    const card = await newCard();
    const agents = await createComment({ cardId: card.id, body: "A question for you", actor: AGENT });
    assert.equal((await call(MEMBER, "DELETE", `/comments/${agents.id}`)).status, 403);

    assert.equal((await call(ADMIN, "DELETE", `/comments/${agents.id}`)).status, 204);
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.id, agents.id))).length, 0);
  });

  it("lets the Admin remove a Member's comment", async () => {
    const card = await newCard();
    const comment = await post(MEMBER, card.id, "oops");
    assert.equal((await call(ADMIN, "DELETE", `/comments/${comment.id}`)).status, 204);
  });
});

describe("the people a Board names", () => {
  it("keeps a removed Member's name, and offers only current, unrevoked people to mention", async () => {
    const card = await newCard(OTHER);
    await post(OTHER, card.id, "a thought");
    await db.insert(schema.users).values({ id: "linus", email: "linus@example.com", handle: "linus", name: "Linus", role: "member", status: "active" });
    await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: "linus" });
    await db.update(schema.users).set({ status: "revoked" }).where(eq(schema.users.id, "linus"));
    await db.delete(schema.boardMembers).where(eq(schema.boardMembers.userId, "grace"));

    const view = await boardView();

    assert.deepEqual(view.members.map((m) => m.id).sort(), ["ada", "admin"]);
    assert.deepEqual(view.people.map((p) => p.id).sort(), ["ada", "admin", "grace", "linus"]);
    const grace = view.people.find((p) => p.id === "grace")!;
    assert.deepEqual(Object.keys(grace).sort(), ["avatarUrl", "handle", "id", "name"], "no email for people");
    assert.equal(grace.name, "Grace");
  });

  it("names someone who only appears in the activity or an Approval", async () => {
    const card = await newCard();
    await db.insert(schema.users).values([
      { id: "old-approver", email: "old@example.com", handle: "old", name: "Old Approver", role: "member", status: "active" },
      { id: "mover", email: "mover@example.com", handle: "mover", name: "Mover", role: "member", status: "active" },
      { id: "stranger", email: "stranger@example.com", handle: "stranger", name: "Stranger", role: "member", status: "active" },
    ]);
    await db.insert(schema.approvals).values({ id: "ap-1", cardId: card.id, userId: "old-approver" });
    await db.insert(schema.events).values({ id: "ev-1", boardId: BOARD, cardId: card.id, actorKind: "user", actorId: "mover", type: "card.moved", payload: {} });

    const ids = (await boardView()).people.map((p) => p.id);

    assert.equal(ids.includes("old-approver"), true);
    assert.equal(ids.includes("mover"), true);
    assert.equal(ids.includes("stranger"), false);
  });
});

describe("a card waiting on an answer", () => {
  async function blockedWithQuestion(): Promise<Card> {
    const card = await newCard();
    await createComment({ cardId: card.id, body: "Which colour should the button be?", actor: AGENT });
    const fresh = (await getCard(card.id))!;
    return moveCard(card.id, { column: "blocked", position: fresh.position, revision: fresh.revision, actor: AGENT });
  }

  it("is marked when the Agent's question is the last word on a Blocked card", async () => {
    const card = await blockedWithQuestion();
    assert.equal(card.awaitingReply, true);
    assert.equal((await boardView()).cards.find((c) => c.id === card.id)!.awaitingReply, true);
  });

  it("is cleared by a person's reply, and not restored by a system notice", async () => {
    const card = await blockedWithQuestion();
    await post(MEMBER, card.id, "Blue, please.");
    assert.equal((await getCard(card.id))!.awaitingReply, false);

    await createComment({ cardId: card.id, body: "kardboard restarted", actor: { kind: "system", id: null } });
    assert.equal((await getCard(card.id))!.awaitingReply, false);
  });

  it("is not marked outside Blocked", async () => {
    const card = await newCard();
    await createComment({ cardId: card.id, body: "Opened a pull request.", actor: AGENT });
    assert.equal((await getCard(card.id))!.awaitingReply, false);
  });

  it("comes back when the reply is deleted", async () => {
    const card = await blockedWithQuestion();
    const reply = await post(MEMBER, card.id, "Blue");
    await call(MEMBER, "DELETE", `/comments/${reply.id}`);
    assert.equal((await getCard(card.id))!.awaitingReply, true);
  });
});

describe("a User's own settings", () => {
  it("defaults to every email and an unseen explainer", async () => {
    const me = (await (await call(MEMBER, "GET", "/me")).json()) as Me;
    assert.equal(me.emailPreference, "all");
    assert.equal(me.onboardedAt, null);
  });

  it("saves an email preference and a dismissed explainer for the caller only", async () => {
    const res = await call(MEMBER, "PATCH", "/me", { emailPreference: "important", onboarded: true });
    assert.equal(res.status, 200);
    const me = (await res.json()) as Me;
    assert.equal(me.emailPreference, "important");
    assert.notEqual(me.onboardedAt, null);

    const again = (await (await call(MEMBER, "PATCH", "/me", { onboarded: true })).json()) as Me;
    assert.equal(again.onboardedAt, me.onboardedAt, "dismissing twice keeps the first time");

    const other = (await (await call(OTHER, "GET", "/me")).json()) as Me;
    assert.equal(other.emailPreference, "all");
    assert.equal(other.onboardedAt, null);
  });

  it("refuses a preference it does not know", async () => {
    assert.equal((await call(MEMBER, "PATCH", "/me", { emailPreference: "weekly" })).status, 400);
  });
});

describe("opening a card", () => {
  it("marks the caller's notifications for it read", async () => {
    const card = await newCard(MEMBER);
    await post(OTHER, card.id, "@ada have a look");
    const res = await call(MEMBER, "POST", `/cards/${card.id}/read`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { unread: number }).unread, 0);
  });

  it("is refused on a Board the caller cannot open", async () => {
    const card = await newCard(MEMBER);
    await db.delete(schema.boardMembers).where(eq(schema.boardMembers.userId, "grace"));
    assert.equal((await call(OTHER, "POST", `/cards/${card.id}/read`)).status, 403);
  });
});
