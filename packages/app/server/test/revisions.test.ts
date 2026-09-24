import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { Card } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-revisions-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { ConflictError, createCard, getCard, moveCard, updateCard } = await import("../src/services/cards.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const AGENT = { kind: "agent" as const, id: null };
const PERSON = { kind: "user" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.triggers, schema.events, schema.cards, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-1", name: "Board one" });
});

async function card(): Promise<Card> {
  return createCard({ boardId: BOARD, title: "A card", description: "", priority: "none", column: "in_progress", actor: AGENT });
}

describe("two changes made from the same revision", () => {
  it("lets only the first move land", async () => {
    const c = await card();
    const results = await Promise.allSettled([
      moveCard(c.id, { column: "review", position: c.position, revision: c.revision, actor: AGENT }),
      moveCard(c.id, { column: "blocked", position: c.position, revision: c.revision, actor: AGENT }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(refused.reason instanceof ConflictError);
    assert.equal((await getCard(c.id))!.revision, c.revision + 1);
  });

  it("lets only the first edit land", async () => {
    const c = await card();
    const results = await Promise.allSettled([
      updateCard(c.id, { title: "First", revision: c.revision, actor: AGENT }),
      updateCard(c.id, { title: "Second", revision: c.revision, actor: AGENT }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await getCard(c.id))!.revision, c.revision + 1);
  });
});

describe("a stale report", () => {
  it("cannot reopen a card a person closed after the agent read it", async () => {
    const c = await card();
    const seen = c.revision;
    await moveCard(c.id, { column: "done", position: c.position, revision: c.revision, actor: PERSON });

    await assert.rejects(moveCard(c.id, { column: "review", position: c.position, revision: seen, actor: AGENT }), ConflictError);
    assert.equal((await getCard(c.id))!.column, "done");
  });
});
