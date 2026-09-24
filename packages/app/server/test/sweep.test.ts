import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first.
// Any runner URL puts the client in http mode; the calls it would make are replaced below.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-sweep-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
process.env.KARDBOARD_RUNNER_URL = "http://runner.invalid";
process.env.KARDBOARD_RUNNER_TOKEN = "test-runner-token";
process.env.KARDBOARD_SWEEP_HOUR = "3";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { runner } = await import("../src/services/runner-client.js");
const { scheduleDispatch } = await import("../src/services/orchestrator.js");
const { sweepTick } = await import("../src/services/sweep.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

runner.start = async (req) => ({ containerId: `container-${req.sessionId}` });
runner.stop = async () => {};

const BOARD = "board-1";

beforeEach(async () => {
  for (const t of [schema.triggers, schema.events, schema.sessions, schema.cards, schema.settings, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-1", name: "Board one", maxConcurrentSessions: 1 });
});

/** A time on the local clock, `daysAgo` days back. Past nights keep every row this test writes, stamped now, after the window opened. */
function night(daysAgo: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function sweeps() {
  return db.select().from(schema.sessions).where(and(eq(schema.sessions.boardId, BOARD), eq(schema.sessions.kind, "sweep")));
}

async function insertSweep(id: string, createdAt: Date) {
  await db.insert(schema.sessions).values({ id, boardId: BOARD, kind: "sweep", provider: "claude", status: "running", createdAt: createdAt.toISOString() });
}

async function dispatchCard(): Promise<string> {
  await db.insert(schema.cards).values({ id: "card-1", boardId: BOARD, title: "A card", column: "ready" });
  await db.insert(schema.triggers).values({ id: "trigger-1", boardId: BOARD, cardId: "card-1", kind: "comment_posted", actorUserId: null, payload: {} });
  scheduleDispatch("card-1", 0);
  await sleep(300);
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.cardId, "card-1")).get())?.status ?? "none";
}

describe("the nightly sweep", () => {
  it("sweeps each Board once in the window", async () => {
    await sweepTick(night(1, 3, 5));
    await sweepTick(night(1, 3, 30));
    const rows = await sweeps();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "running");
  });

  it("skips a paused Board", async () => {
    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, BOARD));
    await sweepTick(night(1, 3, 5));
    assert.deepEqual(await sweeps(), []);
  });

  it("does not sweep again after a restart inside the window", async () => {
    await insertSweep("before-the-restart", night(1, 3, 10));
    await sweepTick(night(1, 3, 30));
    assert.deepEqual((await sweeps()).map((s) => s.id), ["before-the-restart"]);
  });

  it("is not held off by the sweep from the night before", async () => {
    await insertSweep("last-night", night(2, 3, 10));
    await db.update(schema.sessions).set({ status: "succeeded" });
    await sweepTick(night(1, 3, 30));
    assert.equal((await sweeps()).length, 2);
  });

  it("does not take a slot from the Board's own cap", async () => {
    await insertSweep("sweeping", night(0, 0, 0));
    assert.equal(await dispatchCard(), "running", "the Board's one slot is for card work");
  });

  it("still counts against the global cap", async () => {
    await db.insert(schema.settings).values({ key: "globalMaxConcurrentSessions", value: "1" });
    await insertSweep("sweeping", night(0, 0, 0));
    assert.equal(await dispatchCard(), "none");
  });
});
