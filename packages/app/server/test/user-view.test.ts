import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { BoardView, Card, Comment, Me } from "@kardboard/shared";

// What the User sees of a Board and of themselves: who the Board names, which Cards are waiting on
// an answer, deleting a Comment, and their own settings. Dev authentication signs the tests in as
// the User.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-user-view-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { createComment } = await import("../src/services/comments.js");
const { getCard, moveCard } = await import("../src/services/cards.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const AGENT = { kind: "agent" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root", avatarUrl: "https://img.example/root.png" });
});

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newCard(title = "A card"): Promise<Card> {
  const res = await call("POST", "/boards/board-one/cards", { title });
  assert.equal(res.status, 201);
  return (await res.json()) as Card;
}

async function post(cardId: string, body: string): Promise<Comment> {
  const res = await call("POST", `/cards/${cardId}/comments`, { body });
  assert.equal(res.status, 201);
  return (await res.json()) as Comment;
}

async function upload(commentId: string, name: string, text: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  return api.request(`/comments/${commentId}/attachments`, { method: "POST", body: form });
}

async function boardView(): Promise<BoardView> {
  const res = await call("GET", "/boards/board-one");
  assert.equal(res.status, 200);
  return (await res.json()) as BoardView;
}

function uploadExists(sha256: string): boolean {
  return fs.existsSync(path.join(root, "uploads", sha256.slice(0, 2), sha256));
}

describe("deleting a comment", () => {
  it("removes it with its revisions and attachments, and records who", async () => {
    const card = await newCard();
    const comment = await post(card.id, "the password is hunter2");
    assert.equal((await call("PATCH", `/comments/${comment.id}`, { body: "the password is hunter3" })).status, 200);
    assert.equal((await upload(comment.id, "secret.txt", "hunter2")).status, 201);

    const res = await call("DELETE", `/comments/${comment.id}`);

    assert.equal(res.status, 204);
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.id, comment.id))).length, 0);
    assert.equal((await db.select().from(schema.commentRevisions).where(eq(schema.commentRevisions.commentId, comment.id))).length, 0);
    assert.equal((await db.select().from(schema.attachments).where(eq(schema.attachments.commentId, comment.id))).length, 0);
    const deleted = (await db.select().from(schema.events).where(and(eq(schema.events.cardId, card.id), eq(schema.events.type, "comment.deleted"))))[0]!;
    assert.deepEqual(deleted.payload, { commentId: comment.id, authorKind: "user", authorId: "user" });
    assert.equal(deleted.actorId, "user");
    assert.equal(JSON.stringify(deleted.payload).includes("hunter"), false);
    assert.equal((await getCard(card.id))!.commentCount, 0);
  });

  it("removes an uploaded file only once no other attachment uses it", async () => {
    const card = await newCard();
    const first = await post(card.id, "screenshot");
    const second = await post(card.id, "same screenshot again");
    const att = (await (await upload(first.id, "a.txt", "same bytes")).json()) as { id: string };
    await upload(second.id, "b.txt", "same bytes");
    const sha256 = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, att.id)).get())!.sha256;
    assert.equal(uploadExists(sha256), true);

    await call("DELETE", `/comments/${first.id}`);
    assert.equal(uploadExists(sha256), true, "the second comment still shows it");

    await call("DELETE", `/comments/${second.id}`);
    assert.equal(uploadExists(sha256), false);
  });

  it("lets the User remove the Agent's comment", async () => {
    const card = await newCard();
    const agents = await createComment({ cardId: card.id, body: "A question for you", actor: AGENT });

    assert.equal((await call("DELETE", `/comments/${agents.id}`)).status, 204);
    assert.equal((await db.select().from(schema.comments).where(eq(schema.comments.id, agents.id))).length, 0);
    const deleted = (await db.select().from(schema.events).where(eq(schema.events.type, "comment.deleted")))[0]!;
    assert.deepEqual([deleted.payload.authorKind, deleted.actorKind], ["agent", "user"], "the log says whose it was and who removed it");
  });
});

describe("the people a Board names", () => {
  it("is the User, by name and face, without their email", async () => {
    const view = await boardView();
    assert.deepEqual(view.people, [{ id: "user", name: "Root", avatarUrl: "https://img.example/root.png" }]);
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
    await post(card.id, "Blue, please.");
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
    const reply = await post(card.id, "Blue");
    await call("DELETE", `/comments/${reply.id}`);
    assert.equal((await getCard(card.id))!.awaitingReply, true);
  });
});

describe("the User's own settings", () => {
  it("start with an unseen explainer", async () => {
    const me = (await (await call("GET", "/me")).json()) as Me;
    assert.equal(me.user.id, "user");
    assert.equal(me.onboardedAt, null);
  });

  it("save a dismissed explainer, keep the first time, and bring it back on request", async () => {
    const res = await call("PATCH", "/me", { onboarded: true });
    assert.equal(res.status, 200);
    const me = (await res.json()) as Me;
    assert.notEqual(me.onboardedAt, null);

    const again = (await (await call("PATCH", "/me", { onboarded: true })).json()) as Me;
    assert.equal(again.onboardedAt, me.onboardedAt, "dismissing twice keeps the first time");

    const reset = (await (await call("PATCH", "/me", { onboarded: false })).json()) as Me;
    assert.equal(reset.onboardedAt, null);
  });

  it("refuses a value that is not true or false", async () => {
    assert.equal((await call("PATCH", "/me", { onboarded: "yes" })).status, 400);
  });
});
