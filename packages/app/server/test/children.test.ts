import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { Card, Column, Priority } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
// The coalesce delay is pushed out of the way: these tests are about what is written down for a
// Session to pick up, not about the container that eventually picks it up.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-children-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { createCard, getCard, moveCard } = await import("../src/services/cards.js");
const { allChildrenDone, byDispatchOrder, startsItsOwnSession } = await import("../src/services/children.js");
const { buildSessionPrompt } = await import("../src/services/prompt.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const AGENT = { kind: "agent" as const, id: null };
const PERSON = { kind: "user" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.triggers, schema.events, schema.cards, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-1", name: "Board one", repoUrl: "https://github.com/chriscorbell/kardboard" });
});

/** The human request a Session is about to split. */
async function request(title = "A large request"): Promise<Card> {
  return createCard({ boardId: BOARD, title, description: "", priority: "none", column: "ready", actor: PERSON, silent: true });
}

/** One piece of it, as the Session's `create_card` call makes it. */
async function child(parent: Card, title: string, column: Column = "ready", priority: Priority = "none"): Promise<Card> {
  return createCard({ boardId: BOARD, title, description: "", priority, column, actor: AGENT, parentCardId: parent.id });
}

async function triggersFor(cardId: string): Promise<string[]> {
  const rows = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, cardId));
  return rows.map((r) => r.kind);
}

async function toDone(card: Card, opts: { merged?: boolean; actor?: typeof AGENT | typeof PERSON } = {}): Promise<Card> {
  if (opts.merged) {
    // What approveCard records just before it moves the card: kardboard merged the pull request.
    await db.insert(schema.events).values({ id: `event-${card.id}`, boardId: BOARD, cardId: card.id, actorKind: "agent", actorId: null, type: "card.merged", payload: { prNumber: 1 } });
  }
  const fresh = (await getCard(card.id))!;
  return moveCard(card.id, { column: "done", position: fresh.position, revision: fresh.revision, actor: opts.actor ?? AGENT });
}

describe("which cards start their own session", () => {
  it("takes a child of a split request that landed in Ready", () => {
    assert.equal(startsItsOwnSession({ creatorKind: "agent", parentCardId: "parent", column: "ready" }), true);
  });

  it("leaves an agent card with no parent for a person to pick up", () => {
    assert.equal(startsItsOwnSession({ creatorKind: "agent", parentCardId: null, column: "ready" }), false, "an admin step is not agent work");
  });

  it("leaves a child that was parked in Blocked alone", () => {
    assert.equal(startsItsOwnSession({ creatorKind: "agent", parentCardId: "parent", column: "blocked" }), false);
    assert.equal(startsItsOwnSession({ creatorKind: "agent", parentCardId: "parent", column: "review" }), false);
  });

  it("ignores a human card, which has its own trigger already", () => {
    assert.equal(startsItsOwnSession({ creatorKind: "user", parentCardId: "parent", column: "ready" }), false);
  });
});

describe("splitting a request", () => {
  it("starts a session on every child without anyone touching them", async () => {
    const parent = await request();
    const first = await child(parent, "First piece");
    const second = await child(parent, "Second piece");

    assert.deepEqual(await triggersFor(first.id), ["child_card_created"]);
    assert.deepEqual(await triggersFor(second.id), ["child_card_created"]);
    const trigger = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, first.id)).get())!;
    assert.equal(trigger.payload.parentCardId, parent.id, "the child is told which request it is part of");
    assert.equal(trigger.actorUserId, null);
  });

  it("starts nothing for a card the agent left for a person", async () => {
    await createCard({ boardId: BOARD, title: "Apply the firewall rule on minicore", description: "", priority: "medium", column: "ready", actor: AGENT });
    const rows = await db.select().from(schema.triggers);
    assert.deepEqual(rows, [], "an admin step waits in Ready and starts nothing");
  });
});

describe("waking the parent", () => {
  it("waits until the last child is done, then brings the parent back to Ready", async () => {
    const parent = await request();
    const first = await child(parent, "First piece");
    const second = await child(parent, "Second piece");
    await moveCard(parent.id, { column: "blocked", position: parent.position, revision: parent.revision, actor: AGENT });

    await toDone(first, { merged: true });
    assert.equal((await getCard(parent.id))!.column, "blocked", "one child left, so nothing wakes");
    assert.deepEqual(await triggersFor(parent.id), []);

    await toDone(second);
    const woken = (await getCard(parent.id))!;
    assert.equal(woken.column, "ready");
    assert.deepEqual(await triggersFor(parent.id), ["children_done"]);
  });

  it("tells the parent which children were implemented and which were only closed", async () => {
    const parent = await request();
    const built = await child(parent, "The part that shipped");
    const duplicate = await child(parent, "The part that was a duplicate");
    await toDone(built, { merged: true });
    await toDone(duplicate);

    const trigger = (await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, parent.id), eq(schema.triggers.kind, "children_done"))).get())!;
    assert.deepEqual(trigger.payload.children, [
      { id: built.id, title: "The part that shipped", outcome: "implemented" },
      { id: duplicate.id, title: "The part that was a duplicate", outcome: "closed" },
    ]);
  });

  it("records the outcome on the child card, and forgets it if the card is reopened", async () => {
    const parent = await request();
    const only = await child(parent, "The only piece");
    await toDone(only, { merged: true });
    assert.equal((await getCard(only.id))!.outcome, "implemented");

    const done = (await getCard(only.id))!;
    await moveCard(only.id, { column: "in_progress", position: done.position, revision: done.revision, actor: AGENT });
    assert.equal((await getCard(only.id))!.outcome, null, "a reopened card has not ended in anything yet");
  });

  it("wakes the parent when a person closes the last child by hand", async () => {
    const parent = await request();
    const only = await child(parent, "The only piece");
    await toDone(only, { actor: PERSON });
    assert.deepEqual(await triggersFor(parent.id), ["children_done"]);
  });

  it("leaves a parent that is itself closed alone", async () => {
    const parent = await request();
    const only = await child(parent, "The only piece");
    await toDone(parent);
    await toDone(only, { merged: true });
    assert.deepEqual(await triggersFor(parent.id), [], "nothing resumes a card that has already ended");
  });

  it("does not wake a parent whose children are still unfinished", () => {
    assert.equal(allChildrenDone([{ column: "done" }, { column: "review" }]), false);
    assert.equal(allChildrenDone([{ column: "done" }, { column: "done" }]), true);
    assert.equal(allChildrenDone([]), false, "a card with no children is not a settled parent");
  });
});

describe("the order waiting cards are dispatched in", () => {
  const card = (priority: Priority, position: number, createdAt: string) => ({ priority, position, createdAt });

  it("takes priority first, then the board's own order, then age", () => {
    const waiting = [
      card("none", 1000, "2026-09-15T10:00:00.000Z"),
      card("high", 5000, "2026-09-15T12:00:00.000Z"),
      card("medium", 2000, "2026-09-15T09:00:00.000Z"),
      card("medium", 1000, "2026-09-15T11:00:00.000Z"),
    ];
    assert.deepEqual(
      [...waiting].sort(byDispatchOrder).map((c) => `${c.priority}:${c.position}`),
      ["high:5000", "medium:1000", "medium:2000", "none:1000"],
    );
  });

  it("puts the older of two equals first, so nothing waits behind a newer card", () => {
    const older = card("low", 1000, "2026-09-15T09:00:00.000Z");
    const newer = card("low", 1000, "2026-09-15T10:00:00.000Z");
    assert.deepEqual([newer, older].sort(byDispatchOrder), [older, newer]);
  });
});

describe("what the session is told", () => {
  it("points a child at the request it came from", async () => {
    const parent = await request();
    const piece = await child(parent, "First piece");
    const row = (await db.select().from(schema.cards).where(eq(schema.cards.id, piece.id)).get())!;
    const board = (await db.select().from(schema.boards).where(eq(schema.boards.id, BOARD)).get())!;
    const triggers = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, piece.id));

    const prompt = await buildSessionPrompt({ board, card: row, sessionId: "session-1", triggers });
    assert.match(prompt, new RegExp(`split card ${parent.id}`));
    assert.match(prompt, /this piece and only this piece/);
  });

  it("gives the woken parent each child and what it came to", async () => {
    const parent = await request();
    const built = await child(parent, "The part that shipped");
    const duplicate = await child(parent, "The part that was a duplicate");
    await toDone(built, { merged: true });
    await toDone(duplicate);

    const row = (await db.select().from(schema.cards).where(eq(schema.cards.id, parent.id)).get())!;
    const board = (await db.select().from(schema.boards).where(eq(schema.boards.id, BOARD)).get())!;
    const triggers = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, parent.id));

    const prompt = await buildSessionPrompt({ board, card: row, sessionId: "session-2", triggers });
    assert.match(prompt, new RegExp(`${built.id} "The part that shipped": implemented`));
    assert.match(prompt, new RegExp(`${duplicate.id} "The part that was a duplicate": closed`));
    assert.ok(!prompt.includes('"outcome":"implemented"'), "the children are prose, not a payload dump");
  });
});
