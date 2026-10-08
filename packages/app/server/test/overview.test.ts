import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { OverviewView } from "@kardboard/shared";

// The Overview: every Board at once. The database module opens its file at import time, so point it
// at a scratch directory first, and sign in with dev authentication as the one User.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-overview-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { OVERVIEW_BACKLOG_SHOWN } = await import("../src/services/overview.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function card(id: string, boardId: string, column: (typeof schema.cards.$inferInsert)["column"], at = 10) {
  await db.insert(schema.cards).values({ id, boardId, title: `Card ${id}`, column, createdAt: minutesAgo(at), updatedAt: minutesAgo(at) });
}

async function read(): Promise<OverviewView> {
  const res = await api.request("/overview");
  assert.equal(res.status, 200);
  return (await res.json()) as OverviewView;
}

beforeEach(async () => {
  for (const t of [schema.events, schema.comments, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root" });
  // Named so that a sort by raw bytes would put the lowercase one last.
  await db.insert(schema.boards).values([
    { id: "b-recipes", slug: "recipes", name: "Recipes" },
    { id: "b-kard", slug: "kardboard", name: "kardboard" },
    { id: "b-home", slug: "homelab", name: "Homelab" },
  ]);
});

describe("the overview", () => {
  it("lists the boards by name as a person reads it, with what is open on each", async () => {
    await card("k1", "b-kard", "inbox");
    await card("k2", "b-kard", "ready");
    await card("k3", "b-kard", "done");
    const view = await read();
    assert.deepEqual(view.boards.map((b) => b.board.name), ["Homelab", "kardboard", "Recipes"]);
    const kard = view.boards.find((b) => b.board.slug === "kardboard")!;
    assert.deepEqual(kard.open, { inbox: 1, blocked: 0, ready: 1, in_progress: 0, review: 0 });
  });

  it("puts the Agent's questions and the pull requests to review under Needs you, on every board", async () => {
    await card("asked", "b-kard", "blocked", 30);
    await db.insert(schema.comments).values({ id: "q", cardId: "asked", authorKind: "agent", authorId: null, body: "Which crop?" });
    await card("answered", "b-home", "blocked", 20);
    await db.insert(schema.comments).values([
      { id: "q2", cardId: "answered", authorKind: "agent", authorId: null, body: "Which port?", createdAt: minutesAgo(15) },
      { id: "a2", cardId: "answered", authorKind: "user", authorId: "user", body: "8080", createdAt: minutesAgo(10) },
    ]);
    await card("pr", "b-home", "review", 5);
    const view = await read();
    assert.deepEqual(view.needsYou.map((c) => c.id), ["pr", "asked"], "newest first, and an answered question no longer waits");
    assert.equal(view.boards.find((b) => b.board.slug === "homelab")!.needsYou, 1);
    assert.equal(view.boards.find((b) => b.board.slug === "kardboard")!.needsYou, 1);
  });

  it("shows what is in progress everywhere", async () => {
    await card("w1", "b-kard", "in_progress", 50);
    await card("w2", "b-recipes", "in_progress", 5);
    assert.deepEqual((await read()).inProgress.map((c) => c.id), ["w2", "w1"]);
  });

  it("shows the newest Backlog cards and counts the rest", async () => {
    const total = OVERVIEW_BACKLOG_SHOWN + 3;
    for (let i = 0; i < total; i++) await card(`n${i}`, i % 2 ? "b-kard" : "b-home", "inbox", i + 1);
    const view = await read();
    assert.equal(view.backlogTotal, total);
    assert.equal(view.backlog.length, OVERVIEW_BACKLOG_SHOWN);
    assert.equal(view.backlog[0]!.id, "n0", "newest first");
  });

  it("leaves Done out of every list", async () => {
    await card("finished", "b-kard", "done");
    const view = await read();
    assert.equal([...view.needsYou, ...view.inProgress, ...view.backlog].length, 0);
  });
});
