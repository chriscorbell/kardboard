import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first.
// The coalesce delay is pushed out of the way so no Trigger dispatches on its own; each test starts
// the dispatches it is about. Retry waits are cut to milliseconds.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-orchestrator-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
process.env.KARDBOARD_BACKOFF_BASE_MS = "10";
// Any runner URL puts the client in http mode; every call it would make is replaced below.
process.env.KARDBOARD_RUNNER_URL = "http://runner.invalid";
process.env.KARDBOARD_RUNNER_TOKEN = "test-runner-token";

// A stand-in egress proxy that is slow to say nothing is out of usage. A dispatch that checks the
// Card and the caps before this answer and writes after it leaves a window another dispatch can use.
let limitsDelayMs = 0;
const egress = http.createServer((_req, res) => {
  setTimeout(() => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ claude: null, codex: null }));
  }, limitsDelayMs);
});
await new Promise<void>((resolve) => egress.listen(0, "127.0.0.1", resolve));
process.env.KARDBOARD_EGRESS_URL = `http://127.0.0.1:${(egress.address() as AddressInfo).port}`;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { runner } = await import("../src/services/runner-client.js");
const { cancelSession, endSession, enqueueTrigger, recoverOnBoot, scheduleDispatch } = await import("../src/services/orchestrator.js");
const { getCard } = await import("../src/services/cards.js");

await runMigrations();
after(() => {
  egress.closeAllConnections();
  egress.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// The runner as the orchestrator sees it: what it was asked to do, and how it answers.
const fake = {
  starts: [] as string[],
  stops: [] as string[],
  failStarts: 0,
  stopDelayMs: 0,
  inventoryFailures: 0,
  inventoryCalls: 0,
  containers: [] as { containerId: string; sessionId: string; state: string; status: string }[],
};
runner.start = async (req) => {
  fake.starts.push(req.sessionId);
  if (fake.failStarts > 0) {
    fake.failStarts--;
    throw new Error("runner start failed: connect ECONNREFUSED");
  }
  return { containerId: `container-${req.sessionId}` };
};
runner.stop = async (containerId) => {
  await sleep(fake.stopDelayMs);
  fake.stops.push(containerId);
};
runner.inventory = async () => {
  fake.inventoryCalls++;
  if (fake.inventoryFailures > 0) {
    fake.inventoryFailures--;
    throw new Error("runner inventory failed: connect ECONNREFUSED");
  }
  return fake.containers;
};

const BOARD = "board-1";
const ADMIN = { kind: "user" as const, id: null };

beforeEach(async () => {
  for (const t of [schema.triggers, schema.events, schema.sessions, schema.cards, schema.settings, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-1", name: "Board one" });
  Object.assign(fake, { starts: [], stops: [], failStarts: 0, stopDelayMs: 0, inventoryFailures: 0, inventoryCalls: 0, containers: [] });
  limitsDelayMs = 0;
});

let n = 0;
async function makeCard(title = "A card"): Promise<string> {
  const id = `card-${n++}`;
  await db.insert(schema.cards).values({ id, boardId: BOARD, title, column: "ready", position: n });
  return id;
}

/** A human change waiting on the Card, written `ageMs` ago. */
async function addTrigger(cardId: string, ageMs = 0): Promise<string> {
  const id = `trigger-${n++}`;
  await db.insert(schema.triggers).values({ id, boardId: BOARD, cardId, kind: "comment_posted", actorUserId: null, payload: {}, createdAt: new Date(Date.now() - ageMs).toISOString() });
  return id;
}

async function sessionsOn(cardId: string) {
  return db.select().from(schema.sessions).where(eq(schema.sessions.cardId, cardId));
}

async function sessionRow(id: string) {
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get())!;
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/** Dispatches the Card and waits for its Session to be running. */
async function running(cardId: string): Promise<string> {
  await addTrigger(cardId);
  scheduleDispatch(cardId, 0);
  let id = "";
  await until("the session is running", async () => {
    const rows = await sessionsOn(cardId);
    id = rows.find((r) => r.status === "running")?.id ?? "";
    return Boolean(id);
  });
  return id;
}

describe("taking a claim", () => {
  it("starts one Session when two dispatches of the same Card overlap", async () => {
    limitsDelayMs = 150;
    const card = await makeCard();
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await sleep(40);
    scheduleDispatch(card, 0);
    await sleep(500);

    assert.equal((await sessionsOn(card)).length, 1, "one Card, one Claim");
    assert.equal(fake.starts.length, 1);
  });

  it("keeps a Board inside its cap when dispatches of two Cards overlap", async () => {
    await db.update(schema.boards).set({ maxConcurrentSessions: 1 }).where(eq(schema.boards.id, BOARD));
    limitsDelayMs = 150;
    const first = await makeCard("First");
    const second = await makeCard("Second");
    await addTrigger(first);
    await addTrigger(second);
    scheduleDispatch(first, 0);
    scheduleDispatch(second, 0);
    await sleep(500);

    const active = await db.select().from(schema.sessions).where(inArray(schema.sessions.status, ["queued", "starting", "running"]));
    assert.equal(active.length, 1, "the Board's cap is one");
  });
});

describe("starting a session", () => {
  it("retries a start the runner refused, and runs the same Session when it comes back", async () => {
    fake.failStarts = 2;
    const card = await makeCard();
    const session = await running(card);

    assert.deepEqual(fake.starts, [session, session, session], "one Session, three attempts");
    const triggers = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card));
    assert.deepEqual(triggers.map((t) => [t.status, t.sessionId]), [["consumed", session]]);
  });

  it("hands the Triggers back when every attempt fails, rather than dropping the request", async () => {
    fake.failStarts = 99;
    const card = await makeCard();
    const trigger = await addTrigger(card);
    scheduleDispatch(card, 0);
    await until("the session has failed and ended", async () => (await db.select().from(schema.events).where(eq(schema.events.type, "session.failed"))).length === 1);

    const [failed] = await sessionsOn(card);
    assert.match(failed!.outcomeSummary ?? "", /Could not start/);
    assert.equal(fake.starts.length, 3, "the first attempt and two retries");
    const row = (await db.select().from(schema.triggers).where(eq(schema.triggers.id, trigger)).get())!;
    assert.equal(row.status, "pending", "the request is still owed");
    assert.equal(row.sessionId, null);

    await sleep(400);
    assert.equal((await sessionsOn(card)).length, 1, "a start that just failed is not handed the slot it freed");
  });
});

describe("ending a session", () => {
  it("ends it once when a cancel and the container's exit report cross", async () => {
    const card = await makeCard();
    const session = await running(card);
    fake.stopDelayMs = 150;

    await Promise.all([
      cancelSession(session, ADMIN, false),
      sleep(30).then(() => endSession(session, "failed", "Container exited with code 137.")),
    ]);

    assert.equal((await sessionRow(session)).status, "cancelled");
    const ends = await db
      .select()
      .from(schema.events)
      .where(inArray(schema.events.type, ["session.cancelled", "session.failed", "session.succeeded", "session.timed_out"]));
    assert.deepEqual(ends.map((e) => e.type), ["session.cancelled"], "one end, recorded once");
  });

  it("does not start the Card again after a cancel without a re-run", async () => {
    const card = await makeCard();
    const session = await running(card);
    await enqueueTrigger({ card: (await getCard(card))!, kind: "comment_posted", actorUserId: null, payload: {} });
    assert.equal((await getCard(card))!.pendingRerun, true);

    await cancelSession(session, ADMIN, false);
    await sleep(600);

    assert.equal((await sessionsOn(card)).length, 1, "nothing started after the cancel");
    const pending = await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, card), eq(schema.triggers.status, "pending")));
    assert.deepEqual(pending, [], "the pending re-run was cleared with its Triggers");
    assert.equal((await getCard(card))!.pendingRerun, false);
  });

  it("starts the Card again after a cancel and re-run", async () => {
    const card = await makeCard();
    const session = await running(card);
    await enqueueTrigger({ card: (await getCard(card))!, kind: "comment_posted", actorUserId: null, payload: {} });

    await cancelSession(session, ADMIN, true);
    await until("a second session is running", async () => (await sessionsOn(card)).some((s) => s.id !== session && s.status === "running"));
  });
});

describe("handing a freed slot to a waiting card", () => {
  it("leaves a Card still inside its batching window to its own timer", async () => {
    const busy = await makeCard("Busy");
    const session = await running(busy);
    const waiting = await makeCard("Just commented on");
    await addTrigger(waiting);

    await endSession(session, "succeeded", "Done.");
    await sleep(500);
    assert.deepEqual(await sessionsOn(waiting), [], "the batch is still collecting");
  });

  it("takes a Card that has waited past its window", async () => {
    const busy = await makeCard("Busy");
    const session = await running(busy);
    const waiting = await makeCard("Waiting for a slot");
    await addTrigger(waiting, 20 * 60_000);

    await endSession(session, "succeeded", "Done.");
    await until("the waiting card is running", async () => (await sessionsOn(waiting)).some((s) => s.status === "running"));
  });
});

describe("recovering after a restart", () => {
  async function insertSession(id: string, cardId: string, status: "queued" | "running", startedAgoMs = 0) {
    const at = new Date(Date.now() - startedAgoMs).toISOString();
    await db.insert(schema.sessions).values({
      id,
      boardId: BOARD,
      cardId,
      provider: "claude",
      status,
      containerId: status === "running" ? `container-${id}` : null,
      startedAt: status === "running" ? at : null,
      createdAt: at,
    });
  }

  it("waits out a runner that is restarting, then settles each session by what it finds", async () => {
    const [kept, lost, unstarted] = [await makeCard(), await makeCard(), await makeCard()];
    await insertSession("session-kept", kept, "running");
    await insertSession("session-lost", lost, "running");
    await insertSession("session-unstarted", unstarted, "queued");
    const owed = await addTrigger(unstarted);
    await db.update(schema.triggers).set({ status: "consumed", sessionId: "session-unstarted" }).where(eq(schema.triggers.id, owed));
    fake.inventoryFailures = 2;
    fake.containers = [{ containerId: "container-session-kept", sessionId: "session-kept", state: "running", status: "Up 5 minutes" }];

    await recoverOnBoot();
    await until("the lost sessions are settled", async () => (await db.select().from(schema.events).where(eq(schema.events.type, "session.failed"))).length === 2);
    assert.equal((await sessionRow("session-unstarted")).status, "failed");
    assert.equal((await sessionRow("session-lost")).status, "failed");

    assert.equal(fake.inventoryCalls, 3, "two refusals, then an answer");
    assert.equal((await sessionRow("session-kept")).status, "running", "its container is still working");
    assert.match((await sessionRow("session-lost")).outcomeSummary ?? "", /interrupted when kardboard restarted/);
    const trigger = (await db.select().from(schema.triggers).where(eq(schema.triggers.id, owed)).get())!;
    assert.equal(trigger.status, "pending", "a session that never started still owes its Card the request");
  });

  it("still releases every claim on the wall clock when the runner never answers", async () => {
    // Three hundred milliseconds, so the test can see it fire.
    await db.insert(schema.settings).values({ key: "sessionWallClockMinutes", value: "0.005" });
    const [fresh, stale] = [await makeCard(), await makeCard()];
    await insertSession("session-fresh", fresh, "running");
    await insertSession("session-stale", stale, "running", 60 * 60_000);
    fake.inventoryFailures = 99;

    await recoverOnBoot();
    // The row is marked before the container is stopped, so wait for both.
    await until("both sessions have timed out and been stopped", async () => fake.stops.length === 2);
    assert.equal((await sessionRow("session-fresh")).status, "timed_out");
    assert.equal((await sessionRow("session-stale")).status, "timed_out");
    assert.deepEqual(fake.stops.sort(), ["container-session-fresh", "container-session-stale"]);
  });
});
