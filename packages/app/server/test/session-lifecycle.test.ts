import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { Card } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first. The
// coalesce delay is pushed out of the way so no Trigger dispatches on its own, retry waits are cut
// to milliseconds, and any runner URL puts the client in http mode; every call it would make is
// replaced below. Tests sign in with dev authentication, and no email leaves the process.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-lifecycle-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
process.env.KARDBOARD_BACKOFF_BASE_MS = "10";
process.env.KARDBOARD_RUNNER_URL = "http://runner.invalid";
process.env.KARDBOARD_RUNNER_TOKEN = "test-runner-token";
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.test";
process.env.RESEND_API_KEY = "";

// A stand-in egress proxy whose answer each test can set: nothing known, or a provider out of usage.
let limits: Record<string, unknown> = { claude: null, codex: null };
const egress = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(limits));
});
await new Promise<void>((resolve) => egress.listen(0, "127.0.0.1", resolve));
process.env.KARDBOARD_EGRESS_URL = `http://127.0.0.1:${(egress.address() as AddressInfo).port}`;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { runner } = await import("../src/services/runner-client.js");
const { cancelSession, enqueueTrigger, pumpStranded, scheduleDispatch } = await import("../src/services/orchestrator.js");
const { getCard } = await import("../src/services/cards.js");
const { api } = await import("../src/routes/api.js");
const { internal } = await import("../src/routes/internal.js");

await runMigrations();
after(() => {
  egress.closeAllConnections();
  egress.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const fake = { starts: [] as string[], stops: [] as string[], failStarts: 0 };
runner.start = async (req) => {
  fake.starts.push(req.sessionId);
  if (fake.failStarts > 0) {
    fake.failStarts--;
    throw new Error("runner start failed: connect ECONNREFUSED");
  }
  return { containerId: `container-${req.sessionId}` };
};
runner.stop = async (containerId) => {
  fake.stops.push(containerId);
};
runner.inventory = async () => [];

const BOARD = "board-1";
const ADMIN = "root@example.com";
const MEMBER = "ada@example.com";
const OTHER_MEMBER = "grace@example.com";
const OUTSIDER = "zed@example.com";

beforeEach(async () => {
  for (const t of [schema.notifications, schema.outboundEmails, schema.comments, schema.triggers, schema.events, schema.sessions, schema.cards, schema.boardMembers, schema.users, schema.settings, schema.boards]) {
    await db.delete(t);
  }
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values([
    { id: "admin", email: ADMIN, handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "former-admin", email: "old@example.com", handle: "old", name: "Old", role: "admin", status: "revoked" },
    { id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" },
    { id: "grace", email: OTHER_MEMBER, handle: "grace", name: "Grace", role: "member", status: "active" },
    { id: "zed", email: OUTSIDER, handle: "zed", name: "Zed", role: "member", status: "active" },
  ]);
  await db.insert(schema.boardMembers).values([
    { boardId: BOARD, userId: "ada" },
    { boardId: BOARD, userId: "grace" },
  ]);
  Object.assign(fake, { starts: [], stops: [], failStarts: 0 });
  limits = { claude: null, codex: null };
});

let n = 0;
/** A Card Ada asked for. */
async function makeCard(column: Card["column"] = "ready"): Promise<string> {
  const id = `card-${n++}`;
  await db.insert(schema.cards).values({ id, boardId: BOARD, title: `Card ${id}`, column, position: n, creatorKind: "user", creatorId: "ada" });
  return id;
}

async function addTrigger(cardId: string, ageMs = 0): Promise<void> {
  await db.insert(schema.triggers).values({ id: `trigger-${n++}`, boardId: BOARD, cardId, kind: "comment_posted", actorUserId: "ada", payload: {}, createdAt: new Date(Date.now() - ageMs).toISOString() });
}

async function sessionsOn(cardId: string) {
  return db.select().from(schema.sessions).where(eq(schema.sessions.cardId, cardId));
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

async function runningSession(cardId: string): Promise<string | undefined> {
  return (await sessionsOn(cardId)).find((s) => s.status === "running")?.id;
}

/** Dispatches the Card and waits for its Session to be running. */
async function running(cardId: string): Promise<string> {
  await addTrigger(cardId);
  scheduleDispatch(cardId, 0);
  await until("the session is running", async () => Boolean(await runningSession(cardId)));
  return (await runningSession(cardId))!;
}

function exit(sessionId: string, body: Record<string, unknown>) {
  return internal.request(`/sessions/${sessionId}/exit`, {
    method: "POST",
    headers: { authorization: "Bearer test-runner-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(as: string, method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function systemComments(cardId: string) {
  return db.select().from(schema.comments).where(and(eq(schema.comments.cardId, cardId), eq(schema.comments.authorKind, "system")));
}

async function notified(kind = "session_failed") {
  return (await db.select().from(schema.notifications).where(eq(schema.notifications.kind, kind as "session_failed"))).map((r) => r.userId).sort();
}

async function sessionStatus(id: string) {
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get())!;
}

describe("a session that stops short", () => {
  it("posts one notice on the card and tells its creator and the admin, and nobody else", async () => {
    const card = await makeCard();
    const session = await running(card);

    assert.equal((await exit(session, { exitCode: 1 })).status, 200);

    assert.equal((await sessionStatus(session)).status, "failed");
    const notices = await systemComments(card);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.body, /^\*\*Milo stopped before finishing this card\.\*\* It stopped unexpectedly \(exit code 1\)\./);
    assert.match(notices[0]!.body, /Try again/);
    assert.deepEqual(await notified(), ["ada", "admin"], "the creator and the active Admin; not another member, not a revoked Admin");
    const emails = (await db.select().from(schema.outboundEmails)).map((e) => e.toUserId).sort();
    assert.deepEqual(emails, ["ada", "admin"]);
    const pending = await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, card), eq(schema.triggers.status, "pending")));
    assert.deepEqual(pending, [], "the notice is not a Trigger");
  });

  it("says a container that hit its memory limit ran out of memory", async () => {
    const card = await makeCard();
    const session = await running(card);

    await exit(session, { exitCode: 137, oomKilled: true });

    assert.equal((await sessionStatus(session)).outcomeSummary, "It ran out of memory.");
    assert.match((await systemComments(card))[0]!.body, /It ran out of memory\./);
  });

  it("tells people when a session hits its time limit", async () => {
    // Three hundred milliseconds, so the test can see it fire.
    await db.insert(schema.settings).values({ key: "sessionWallClockMinutes", value: "0.005" });
    const card = await makeCard();
    const session = await running(card);

    await until("the session has timed out", async () => (await systemComments(card)).length === 1);
    assert.equal((await sessionStatus(session)).status, "timed_out");
    assert.match((await systemComments(card))[0]!.body, /time limit/);
    assert.deepEqual(await notified(), ["ada", "admin"]);
  });

  it("stays quiet when the admin cancels", async () => {
    const card = await makeCard();
    const session = await running(card);

    await cancelSession(session, { kind: "user", id: "admin" }, false);

    assert.deepEqual(await systemComments(card), []);
    assert.deepEqual(await notified(), []);
  });

  it("stays quiet when the card falls back to the other provider at once", async () => {
    const card = await makeCard();
    const session = await running(card);
    limits = { claude: { at: new Date().toISOString(), until: null }, codex: null };

    await exit(session, { exitCode: 1 });

    const kinds = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card))).map((t) => t.kind);
    assert.ok(kinds.includes("provider_fallback"), "the card is picked up again on Codex");
    assert.deepEqual(await systemComments(card), []);
    assert.deepEqual(await notified(), []);
  });

  it("stays quiet when a session could not start, since its request is still owed", async () => {
    fake.failStarts = 99;
    const card = await makeCard();
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await until("the start has failed", async () => (await sessionsOn(card)).some((s) => s.status === "failed"));
    await sleep(50);

    assert.deepEqual(await systemComments(card), []);
    assert.deepEqual(await notified(), []);
  });
});

describe("a start that keeps failing", () => {
  it("sets the request aside after three rounds and tells the card's people", async () => {
    fake.failStarts = 99;
    const card = await makeCard();
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    for (const id of ["round-1", "round-2"]) {
      await db.insert(schema.sessions).values({ id, boardId: BOARD, cardId: card, provider: "claude", status: "failed", outcomeSummary: "Could not start: image not found", endedAt: longAgo, createdAt: longAgo });
    }
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await until("the third round has failed", async () => (await sessionsOn(card)).filter((s) => s.status === "failed").length === 3);
    await until("the card's people are told", async () => (await systemComments(card)).length === 1);

    assert.match((await systemComments(card))[0]!.body, /could not be started 3 times in a row/);
    assert.deepEqual(await notified(), ["ada", "admin"]);
    const pending = await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, card), eq(schema.triggers.status, "pending")));
    assert.deepEqual(pending, [], "the pumps no longer retry it");
    assert.equal((await getCard(card))!.waiting, null);
  });
});

describe("a start that keeps failing, with a change made during the last round", () => {
  it("sets aside only what the failed rounds were for", async () => {
    fake.failStarts = 99;
    const card = await makeCard();
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    for (const id of ["early-1", "early-2"]) {
      await db.insert(schema.sessions).values({ id, boardId: BOARD, cardId: card, provider: "claude", status: "failed", outcomeSummary: "Could not start: image not found", endedAt: longAgo, createdAt: longAgo });
    }
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await until("the third round has started", async () => (await sessionsOn(card)).length === 3);
    await db.insert(schema.triggers).values({ id: "later", boardId: BOARD, cardId: card, kind: "comment_posted", actorUserId: "ada", payload: {}, createdAt: new Date(Date.now() + 1_000).toISOString() });
    await until("the card's people are told", async () => (await systemComments(card)).length === 1);

    const pending = await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, card), eq(schema.triggers.status, "pending")));
    assert.deepEqual(pending.map((t) => t.id), ["later"]);
  });
});

describe("a re-run whose change was taken back", () => {
  it("clears the flag rather than promising a session that has nothing to do", async () => {
    const card = await makeCard();
    const session = await running(card);
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, card));
    const { endSession } = await import("../src/services/orchestrator.js");
    await endSession(session, "failed", "It stopped unexpectedly (exit code 1).");
    await until("the notice is posted", async () => (await systemComments(card)).length === 1);

    assert.doesNotMatch((await systemComments(card))[0]!.body, /starting again/);
    const after = (await getCard(card))!;
    assert.equal(after.pendingRerun, false);
    assert.equal(after.lastSession?.status, "failed", "so Try again is offered");
  });
});

describe("a session that fails on a paused board", () => {
  it("does not promise a re-run that the pause holds back", async () => {
    const card = await makeCard();
    const session = await running(card);
    await addTrigger(card);
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, card));
    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, BOARD));
    const { endSession } = await import("../src/services/orchestrator.js");
    await endSession(session, "failed", "It stopped unexpectedly (exit code 1).");
    await until("the notice is posted", async () => (await systemComments(card)).length === 1);

    assert.doesNotMatch((await systemComments(card))[0]!.body, /starting again/);
    assert.equal((await getCard(card))!.waiting?.reason, "paused");
  });
});

describe("a notice that quotes the agent", () => {
  it("names nobody a second time", async () => {
    const card = await makeCard();
    const session = await running(card);
    const { endSession } = await import("../src/services/orchestrator.js");
    await endSession(session, "failed", "Asked @grace which schema to use.");
    await until("the notice is posted", async () => (await systemComments(card)).length === 1);

    assert.deepEqual(await notified("mention"), []);
    assert.deepEqual(await db.select().from(schema.mentions), []);
  });
});

describe("a container that exits cleanly", () => {
  it("fails a session that neither commented nor reported, and says so", async () => {
    const card = await makeCard();
    const session = await running(card);

    await exit(session, { exitCode: 0 });

    const row = await sessionStatus(session);
    assert.equal(row.status, "failed");
    assert.equal(row.outcomeSummary, "It ended without reporting back.");
    assert.equal((await systemComments(card)).length, 1);
  });

  it("succeeds a session that commented before it exited", async () => {
    const card = await makeCard();
    const session = await running(card);
    await db.insert(schema.comments).values({ id: `comment-${n++}`, cardId: card, authorKind: "agent", sessionId: session, body: "Done: see the pull request." });

    await exit(session, { exitCode: 0 });

    assert.equal((await sessionStatus(session)).status, "succeeded");
    assert.deepEqual(await systemComments(card), []);
  });

  it("ends the way finish reported it when the exit lands first", async () => {
    const card = await makeCard();
    const session = await running(card);
    await db.insert(schema.events).values({ id: `event-${n++}`, boardId: BOARD, cardId: card, actorKind: "agent", type: "session.reported", payload: { sessionId: session, summary: "Nothing to change: the typo was already fixed.", outcome: "succeeded" } });

    await exit(session, { exitCode: 0 });

    const row = await sessionStatus(session);
    assert.equal(row.status, "succeeded");
    assert.equal(row.outcomeSummary, "Nothing to change: the typo was already fixed.");
    assert.deepEqual(await systemComments(card), []);
  });

  it("carries a failure the session reported onto the card in its own words", async () => {
    const card = await makeCard();
    const session = await running(card);
    await db.insert(schema.events).values({ id: `event-${n++}`, boardId: BOARD, cardId: card, actorKind: "agent", type: "session.reported", payload: { sessionId: session, summary: "The repository would not build", outcome: "failed" } });

    await exit(session, { exitCode: 0 });

    assert.equal((await sessionStatus(session)).status, "failed");
    assert.match((await systemComments(card))[0]!.body, /The repository would not build\./);
  });
});

describe("try again", () => {
  async function failedCard(column: Card["column"] = "ready"): Promise<string> {
    const card = await makeCard(column);
    const at = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.sessions).values({ id: `session-${n++}`, boardId: BOARD, cardId: card, provider: "claude", status: "failed", outcomeSummary: "It ran out of memory.", startedAt: at, endedAt: at, createdAt: at });
    return card;
  }

  it("starts a session at once for any member of the board, pointing it at the run that failed", async () => {
    const card = await failedCard();
    const before = (await getCard(card))!;
    assert.equal(before.lastSession?.status, "failed");

    const res = await call(OTHER_MEMBER, "POST", `/cards/${card}/retry`);
    assert.equal(res.status, 201);

    await until("a new session is running", async () => Boolean(await runningSession(card)));
    const trigger = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card)).get())!;
    assert.equal(trigger.kind, "retry_requested");
    assert.equal(trigger.actorUserId, "grace");
    assert.equal(trigger.payload.sessionId, before.lastSession!.id);
    const events = (await db.select().from(schema.events).where(eq(schema.events.cardId, card))).map((e) => e.type);
    assert.ok(events.includes("card.retry_requested"));
  });

  it("is refused to someone who cannot open the board", async () => {
    const card = await failedCard();
    assert.equal((await call(OUTSIDER, "POST", `/cards/${card}/retry`)).status, 403);
    assert.deepEqual(await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card)), []);
  });

  it("is refused while a session is working on the card", async () => {
    const card = await makeCard();
    await running(card);
    const res = await call(MEMBER, "POST", `/cards/${card}/retry`);
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /already working/);
    const kinds = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card))).map((t) => t.kind);
    assert.equal(kinds.includes("retry_requested"), false);
  });

  it("is refused on a card in done", async () => {
    const card = await failedCard("done");
    assert.equal((await call(MEMBER, "POST", `/cards/${card}/retry`)).status, 409);
  });

  it("is refused when the last session did not fail", async () => {
    const card = await makeCard();
    const at = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.sessions).values({ id: `session-${n++}`, boardId: BOARD, cardId: card, provider: "claude", status: "succeeded", outcomeSummary: "Opened a pull request.", startedAt: at, endedAt: at, createdAt: at });
    const res = await call(MEMBER, "POST", `/cards/${card}/retry`);
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /did not fail/);
    assert.equal((await call(MEMBER, "POST", `/cards/${await makeCard()}/retry`)).status, 409, "nor on a card that never ran");
  });
});

describe("what a waiting card shows", () => {
  it("shows its batching window after a person's change, dated from the change", async () => {
    const card = await makeCard();
    await call(MEMBER, "POST", `/cards/${card}/comments`, { body: "one more thing" });

    const shown = (await getCard(card))!;
    const trigger = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, card)).get())!;
    assert.deepEqual(shown.waiting, { reason: "coalescing", since: trigger.createdAt });
  });

  it("shows a full cap as waiting for a slot", async () => {
    await db.update(schema.boards).set({ maxConcurrentSessions: 1 }).where(eq(schema.boards.id, BOARD));
    await running(await makeCard());
    const card = await makeCard();
    await call(MEMBER, "POST", `/cards/${card}/comments`, { body: "when you can" });

    assert.equal((await getCard(card))!.waiting?.reason, "slot");
  });

  it("shows a paused board", async () => {
    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, BOARD));
    const card = await makeCard();
    await call(MEMBER, "POST", `/cards/${card}/comments`, { body: "whenever" });

    assert.equal((await getCard(card))!.waiting?.reason, "paused");
  });

  it("shows a retry after a start that failed, alongside the session that could not start", async () => {
    fake.failStarts = 99;
    const card = await makeCard();
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await until("the start has failed", async () => (await sessionsOn(card)).some((s) => s.status === "failed"));

    const shown = (await getCard(card))!;
    assert.equal(shown.waiting?.reason, "retrying");
    assert.equal(shown.lastSession?.status, "failed");
    assert.equal(shown.lastSession?.startedAt, null);
  });

  it("shows nothing while a session holds the card, and the session once it has ended", async () => {
    const card = await makeCard();
    const session = await running(card);
    assert.equal((await getCard(card))!.waiting, null);

    await exit(session, { exitCode: 1 });
    const shown = (await getCard(card))!;
    assert.equal(shown.activeSession, null);
    assert.equal(shown.lastSession?.id, session);
    assert.equal(shown.waiting, null);
  });
});

describe("the batching window's cap", () => {
  it("dispatches at once when the oldest waiting change is past the cap", async () => {
    const card = await makeCard();
    // The cap is never shorter than the window, which these tests set to ten minutes.
    await addTrigger(card, 11 * 60_000);

    await enqueueTrigger({ card: (await getCard(card))!, kind: "comment_posted", actorUserId: "ada", payload: {} });

    await until("the card is running", async () => Boolean(await runningSession(card)));
  });

  it("still waits out the window for a fresh batch", async () => {
    const card = await makeCard();
    await enqueueTrigger({ card: (await getCard(card))!, kind: "comment_posted", actorUserId: "ada", payload: {} });
    await sleep(300);
    assert.deepEqual(await sessionsOn(card), []);
  });
});

describe("the periodic pump", () => {
  it("starts a card that is owed a session and that nothing else would dispatch", async () => {
    const card = await makeCard();
    await addTrigger(card, 20 * 60_000);

    assert.equal(await pumpStranded(), 1);
    await until("the card is running", async () => Boolean(await runningSession(card)));
  });

  it("waits out the backoff after a start that failed, then tries again", async () => {
    const card = await makeCard();
    await addTrigger(card, 20 * 60_000);
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.sessions).values({ id: "could-not-start", boardId: BOARD, cardId: card, provider: "claude", status: "failed", outcomeSummary: "Could not start: connect ECONNREFUSED", endedAt, createdAt: endedAt });

    assert.equal(await pumpStranded(), 0, "a minute after the failure");

    const longAgo = new Date(Date.now() - 11 * 60_000).toISOString();
    await db.update(schema.sessions).set({ endedAt: longAgo, createdAt: longAgo }).where(eq(schema.sessions.id, "could-not-start"));
    assert.equal(await pumpStranded(), 1, "eleven minutes after it");
    await until("the card is running", async () => Boolean(await runningSession(card)));
  });

  it("leaves a card whose dispatch is already planned", async () => {
    const card = await makeCard();
    await addTrigger(card);
    scheduleDispatch(card, 600_000);
    assert.equal(await pumpStranded(), 0);
  });

  it("starts no more cards than there are free slots, and none on a paused board", async () => {
    await db.update(schema.boards).set({ maxConcurrentSessions: 1 }).where(eq(schema.boards.id, BOARD));
    const [first, second] = [await makeCard(), await makeCard()];
    await addTrigger(first, 20 * 60_000);
    await addTrigger(second, 20 * 60_000);

    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, BOARD));
    assert.equal(await pumpStranded(), 0);
    await db.update(schema.boards).set({ paused: false }).where(eq(schema.boards.id, BOARD));
    assert.equal(await pumpStranded(), 1);
  });
});

describe("pausing a board", () => {
  it("starts nothing while paused, and dispatches what waited when resumed", async () => {
    assert.equal((await call(ADMIN, "POST", `/admin/boards/${BOARD}/pause`, { paused: true })).status, 200);
    const card = await makeCard();
    await addTrigger(card);
    scheduleDispatch(card, 0);
    await sleep(300);
    assert.deepEqual(await sessionsOn(card), [], "nothing starts on a paused board");
    const pending = await db.select().from(schema.triggers).where(and(eq(schema.triggers.cardId, card), eq(schema.triggers.status, "pending")));
    assert.equal(pending.length, 1, "the change is still owed");

    const res = await call(ADMIN, "POST", `/admin/boards/${BOARD}/pause`, { paused: false });
    assert.equal(((await res.json()) as { paused: boolean }).paused, false);
    await until("the card is running", async () => Boolean(await runningSession(card)));
    const events = (await db.select().from(schema.events).where(eq(schema.events.boardId, BOARD))).map((e) => e.type);
    assert.ok(events.includes("board.paused") && events.includes("board.resumed"));
  });

  it("is the admin's switch alone", async () => {
    assert.equal((await call(MEMBER, "POST", `/admin/boards/${BOARD}/pause`, { paused: true })).status, 403);
  });

  it("stays where it was when the board's settings are saved without it", async () => {
    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, BOARD));
    const res = await call(ADMIN, "PATCH", `/admin/boards/${BOARD}`, { name: "Board one", slug: "board-one" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { paused: boolean }).paused, true);
  });
});
