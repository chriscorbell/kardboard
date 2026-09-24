import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { githubAppEnv, installFakeGitHub } from "./fake-github.js";

// kardboard settling Cards against what happened to their pull requests on GitHub. The database
// and the merge App are read at import time, so both are set first; Triggers are held back so a
// test sees what a Card is owed rather than a Session starting on it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-reconcile-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
githubAppEnv();

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { getCard, moveCard } = await import("../src/services/cards.js");
const { approveCard, listApprovals, retryMerge, underCardLock } = await import("../src/services/approvals.js");
const { reconcileCard, reconcileOnDemand, reconcilePullRequests } = await import("../src/services/reconcile.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();

const REPO = "acme/widgets";
const BRANCH = "kardboard/card-1-the-change";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const CARD = "card-1";

const github = installFakeGitHub(REPO);

after(() => {
  github.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of [schema.previews, schema.approvals, schema.sessions, schema.triggers, schema.events, schema.notifications, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  github.reset();
  await db.insert(schema.boards).values({ id: "board-1", slug: "board-one", name: "Board one", repoUrl: `https://github.com/${REPO}` });
  await db.insert(schema.users).values({ id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" });
  await db.insert(schema.users).values({ id: "bea", email: "bea@example.com", handle: "bea", name: "Bea", role: "member", status: "active" });
  await db.insert(schema.boardMembers).values([
    { boardId: "board-1", userId: "ada" },
    { boardId: "board-1", userId: "bea" },
  ]);
  await db.insert(schema.cards).values({ id: CARD, boardId: "board-1", title: "The change", column: "review", creatorKind: "user", creatorId: "ada", branch: BRANCH, prNumber: 7, prUrl: `https://github.com/${REPO}/pull/7`, prHeadSha: HEAD_A, prBaseRef: "main" });
  github.pulls.set(7, { ref: BRANCH, repo: REPO, sha: HEAD_A, state: "open" });
});

async function comments(cardId = CARD): Promise<string[]> {
  return (await db.select().from(schema.comments).where(eq(schema.comments.cardId, cardId))).map((c) => c.body);
}

async function events(type: string, cardId = CARD) {
  return db.select().from(schema.events).where(and(eq(schema.events.cardId, cardId), eq(schema.events.type, type)));
}

async function startSession(cardId = CARD): Promise<void> {
  await db.insert(schema.sessions).values({ id: `session-${cardId}`, boardId: "board-1", cardId, kind: "card", provider: "claude", status: "running", branch: BRANCH });
}

function mergedOnGitHub(number = 7): void {
  const p = github.pulls.get(number)!;
  p.state = "closed";
  p.merged = true;
  p.closedAt = "2026-09-24T10:00:00.000Z";
}

describe("a pull request merged on GitHub", () => {
  it("completes the card as kardboard's own merge would", async () => {
    await startSession();
    await db.insert(schema.previews).values({ id: "preview-1", boardId: "board-1", cardId: CARD, host: "card-1.example.com", branch: BRANCH });
    mergedOnGitHub();

    assert.equal(await reconcileCard(CARD), "merged");

    const card = (await getCard(CARD))!;
    assert.equal(card.column, "done");
    assert.equal(card.outcome, "implemented", "a merge is implemented work, whoever pressed the button");
    assert.equal(card.activeSession, null, "the session still at work was ended");
    const session = (await db.select().from(schema.sessions).where(eq(schema.sessions.id, `session-${CARD}`)).get())!;
    assert.equal(session.status, "cancelled");
    assert.deepEqual(await db.select().from(schema.previews), [], "the preview went with the card");
    const [merged] = await events("card.merged");
    assert.equal(merged?.payload.prNumber, 7);
    assert.equal(merged?.payload.onGitHub, true);
    assert.deepEqual(await comments(), ["Pull request #7 was merged on GitHub, so this card is Done."]);
    assert.deepEqual(await db.select().from(schema.triggers), [], "nothing here is a Trigger");
  });

  it("wakes the parent of a split request with this piece counted as implemented", async () => {
    await db.insert(schema.cards).values({ id: "parent", boardId: "board-1", title: "The whole request", column: "blocked", creatorKind: "user", creatorId: "ada" });
    await db.update(schema.cards).set({ parentCardId: "parent", creatorKind: "agent", creatorId: null }).where(eq(schema.cards.id, CARD));
    mergedOnGitHub();

    await reconcileCard(CARD);

    assert.equal((await getCard("parent"))!.column, "ready");
    const trigger = (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, "parent")).get())!;
    assert.equal(trigger.kind, "children_done");
    assert.deepEqual(trigger.payload.children, [{ id: CARD, title: "The change", outcome: "implemented" }]);
  });

  it("finishes a merge kardboard made but a restart cut short, without recording it twice", async () => {
    await db.insert(schema.events).values({ id: "merged-1", boardId: "board-1", cardId: CARD, actorKind: "agent", actorId: null, type: "card.merged", payload: { prNumber: 7, mergeSha: "c".repeat(40) } });
    mergedOnGitHub();

    await reconcilePullRequests();

    const card = (await getCard(CARD))!;
    assert.equal(card.column, "done");
    assert.equal(card.outcome, "implemented");
    assert.equal((await events("card.merged")).length, 1);
    assert.deepEqual(await comments(), ["Merged pull request #7 and moved this card to Done."]);
  });
});

describe("a card reopened after its pull request merged", () => {
  const AGENT_ACTOR = { kind: "agent" as const, id: null };

  it("forgets the merged pull request, so the poll leaves the new work alone", async () => {
    await approveCard(CARD, { kind: "user", id: "bea" }, HEAD_A);
    const done = (await getCard(CARD))!;
    assert.equal(done.column, "done");

    // A comment reopens it, and the Session takes it to In Progress to open a new pull request.
    const reopened = await moveCard(CARD, { column: "in_progress", position: done.position, revision: done.revision, actor: AGENT_ACTOR });
    assert.deepEqual([reopened.prNumber, reopened.prUrl, reopened.prHeadSha, reopened.prBaseRef, reopened.checks], [null, null, null, null, null]);
    assert.equal(reopened.branch, BRANCH, "the branch stays the card's for its whole life");
    assert.ok((await listApprovals(CARD)).every((a) => a.invalidatedAt), "the approval the merge spent does not stand on the reopened card");

    await startSession();
    const asked = github.requests.length;
    const said = (await comments()).length;
    assert.equal(await reconcileCard(CARD), "skipped");

    const card = (await getCard(CARD))!;
    assert.equal(card.column, "in_progress");
    assert.notEqual(card.activeSession, null, "the session doing the new work is not ended");
    assert.deepEqual(github.requests.slice(asked), [], "the branch the session pushes to is not deleted");
    assert.equal((await comments()).length, said);
    assert.equal((await events("card.merged")).length, 1);
  });

  it("keeps a pull request that was closed without a merge", async () => {
    const review = (await getCard(CARD))!;
    const done = await moveCard(CARD, { column: "done", position: review.position, revision: review.revision, actor: { kind: "user", id: "ada" } });
    const reopened = await moveCard(CARD, { column: "in_progress", position: done.position, revision: done.revision, actor: AGENT_ACTOR });
    assert.deepEqual([reopened.prNumber, reopened.prHeadSha], [7, HEAD_A], "the work may go on in the same pull request");
  });

  it("is not completed again when it still names the merged pull request", async () => {
    // A card reopened before moveCard forgot a merged pull request: merged, in Done, and out again.
    await db.update(schema.cards).set({ column: "in_progress" }).where(eq(schema.cards.id, CARD));
    await db.insert(schema.events).values([
      { id: "e1", boardId: "board-1", cardId: CARD, actorKind: "agent", actorId: null, type: "card.merged", payload: { prNumber: 7, mergeSha: "c".repeat(40) }, createdAt: "2026-09-24T10:00:00.000Z" },
      { id: "e2", boardId: "board-1", cardId: CARD, actorKind: "agent", actorId: null, type: "card.moved", payload: { from: "review", to: "done" }, createdAt: "2026-09-24T10:00:00.001Z" },
      { id: "e3", boardId: "board-1", cardId: CARD, actorKind: "agent", actorId: null, type: "card.moved", payload: { from: "done", to: "in_progress" }, createdAt: "2026-09-24T11:00:00.000Z" },
    ]);
    await db.insert(schema.approvals).values({ id: "approval-1", cardId: CARD, userId: "bea", prNumber: 7, headSha: HEAD_A });
    await startSession();
    mergedOnGitHub();

    assert.equal(await reconcileCard(CARD), "skipped");

    const card = (await getCard(CARD))!;
    assert.equal(card.column, "in_progress");
    assert.notEqual(card.activeSession, null);
    assert.equal(card.prNumber, null, "the merged pull request is forgotten, as moveCard now does");
    assert.notEqual((await listApprovals(CARD))[0]!.invalidatedAt, null);
    assert.deepEqual(
      github.requests.filter((r) => r.startsWith("DELETE")),
      [],
    );
    assert.deepEqual(await comments(), []);
    assert.equal(await reconcileCard(CARD), "skipped", "and the next poll has nothing to ask GitHub");
  });
});

describe("a pull request closed without a merge", () => {
  it("moves the card to Blocked and asks its creator what to do, once", async () => {
    const p = github.pulls.get(7)!;
    p.state = "closed";
    p.closedAt = "2026-09-24T10:00:00.000Z";

    assert.equal(await reconcileCard(CARD), "closed");
    assert.equal(await reconcileCard(CARD), "unchanged", "the next poll sees the same closing");

    const card = (await getCard(CARD))!;
    assert.equal(card.column, "blocked");
    assert.equal(card.outcome, null);
    const said = await comments();
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^@ada Pull request #7 was closed on GitHub without being merged/);
    assert.deepEqual(await db.select().from(schema.triggers), [], "the question is for a person, not a Session");
  });

  it("leaves the card to a session that holds the claim", async () => {
    await startSession();
    const p = github.pulls.get(7)!;
    p.state = "closed";
    p.closedAt = "2026-09-24T10:00:00.000Z";

    assert.equal(await reconcileCard(CARD), "unchanged");

    assert.equal((await getCard(CARD))!.column, "review");
    assert.deepEqual(await comments(), []);
  });
});

describe("new commits on the branch", () => {
  it("shows the new head in Review, voids the approval on the old one, and asks for another look", async () => {
    await db.insert(schema.approvals).values({ id: "approval-1", cardId: CARD, userId: "bea", prNumber: 7, headSha: HEAD_A, mergeError: "422 Rate limited" });
    github.pulls.get(7)!.sha = HEAD_B;

    assert.equal(await reconcileCard(CARD), "head_changed");

    const card = (await getCard(CARD))!;
    assert.equal(card.prHeadSha, HEAD_B);
    assert.notEqual((await listApprovals(CARD))[0]!.invalidatedAt, null);
    const said = await comments();
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^@bea New commits were pushed to pull request #7, which now stands at bbbbbbb/);
    assert.equal((await events("pull_request.head_changed"))[0]?.payload.to, HEAD_B);
  });

  it("only records the head while a session holds the claim, since the session pushed it", async () => {
    await startSession();
    github.pulls.get(7)!.sha = HEAD_B;

    assert.equal(await reconcileCard(CARD), "unchanged");

    assert.equal((await getCard(CARD))!.prHeadSha, HEAD_B);
    assert.deepEqual(await comments(), []);
    assert.deepEqual(await events("pull_request.head_changed"), []);
  });

  it("only records the head of a card that is not in Review", async () => {
    await db.update(schema.cards).set({ column: "in_progress" }).where(eq(schema.cards.id, CARD));
    github.pulls.get(7)!.sha = HEAD_B;

    await reconcileCard(CARD);

    assert.equal((await getCard(CARD))!.prHeadSha, HEAD_B);
    assert.deepEqual(await comments(), []);
  });
});

describe("a merge a restart cut short", () => {
  it("gets the refusal, so the card offers to try merging again", async () => {
    await db.insert(schema.approvals).values({ id: "approval-1", cardId: CARD, userId: "bea", prNumber: 7, headSha: HEAD_A });

    await reconcileCard(CARD);

    const [approval] = await listApprovals(CARD);
    assert.equal(approval!.invalidatedAt, null);
    assert.equal(approval!.mergeError, "The merge on this approval did not finish, and nothing was merged.");
    assert.match((await comments())[0]!, /^@bea The merge of pull request #7 on this approval did not finish, and nothing was merged\./);
    assert.doesNotMatch((await comments())[0]!, /restart/, "the poll cannot tell a restart from an older approval, so it does not say which");

    await retryMerge(CARD, { kind: "user", id: "bea" });
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
    assert.equal((await getCard(CARD))!.column, "done");
  });
});

describe("a poll GitHub answers slowly", () => {
  // Runs `meanwhile` while the poll waits for GitHub's answer about pull request #7.
  async function whileAsking<T>(meanwhile: () => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/pulls/7") && (init?.method ?? "GET") === "GET") await meanwhile();
      return fake(input, init);
    }) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = fake;
    }
  }

  it("does not put back an older head over the one a Session reported meanwhile", async () => {
    const HEAD_C = "f".repeat(40);
    github.pulls.get(7)!.sha = HEAD_B;

    const result = await whileAsking(() => db.update(schema.cards).set({ prHeadSha: HEAD_C }).where(eq(schema.cards.id, CARD)), () => reconcileCard(CARD));

    assert.equal(result, "unchanged");
    assert.equal((await getCard(CARD))!.prHeadSha, HEAD_C);
    assert.deepEqual(await comments(), []);
    assert.deepEqual(await events("pull_request.head_changed"), []);
  });

  it("does not move a card to Blocked when a Session started meanwhile", async () => {
    const p = github.pulls.get(7)!;
    p.state = "closed";
    p.closedAt = "2026-09-24T10:00:00.000Z";

    const result = await whileAsking(() => startSession(), () => reconcileCard(CARD));

    assert.equal(result, "unchanged");
    assert.equal((await getCard(CARD))!.column, "review");
    assert.deepEqual(await comments(), []);
    assert.deepEqual(await events("pull_request.closed"), [], "the closing is still to be handled once the session is done");
  });
});

describe("the poll", () => {
  it("records CI for cards in Review", async () => {
    github.checkRuns.set(HEAD_A, [{ name: "test", status: "in_progress", conclusion: null }]);

    await reconcileCard(CARD);

    const checks = (await getCard(CARD))!.checks;
    assert.deepEqual([checks?.state, checks?.pending, checks?.sha], ["pending", 1, HEAD_A]);
  });

  it("leaves Done cards, cards with no pull request, and cards on boards without GitHub alone", async () => {
    await db.update(schema.cards).set({ column: "done" }).where(eq(schema.cards.id, CARD));
    await db.insert(schema.cards).values({ id: "card-2", boardId: "board-1", title: "No pull request yet", column: "in_progress", creatorKind: "user", creatorId: "ada" });
    await db.insert(schema.boards).values({ id: "board-2", slug: "board-two", name: "Board two", repoUrl: null });
    await db.insert(schema.cards).values({ id: "card-3", boardId: "board-2", title: "Elsewhere", column: "review", creatorKind: "user", creatorId: "ada", prNumber: 7 });
    mergedOnGitHub();

    await reconcilePullRequests();

    assert.equal((await getCard(CARD))!.outcome, null);
    assert.equal((await getCard("card-3"))!.column, "review");
    assert.deepEqual(
      github.requests.filter((r) => r.includes("/pulls/")),
      [],
    );
  });

  it("goes on to the next card when one cannot be read", async () => {
    await db.insert(schema.cards).values({ id: "card-2", boardId: "board-1", title: "Broken", column: "review", creatorKind: "user", creatorId: "ada", branch: "kardboard/card-2", prNumber: 404, prHeadSha: HEAD_A });
    const realFetch = globalThis.fetch;
    const failing = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).endsWith("/pulls/404")) throw new TypeError("fetch failed");
      return failing(input, init);
    }) as typeof fetch;
    try {
      mergedOnGitHub();
      await reconcilePullRequests();
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal((await getCard(CARD))!.column, "done");
  });

  it("stays out of the way of an Approve already at work on the card", async () => {
    let release!: () => void;
    const held = underCardLock(CARD, () => new Promise<void>((resolve) => (release = resolve)));
    mergedOnGitHub();

    assert.equal(await reconcileCard(CARD), "busy");
    release();
    await held;
    assert.equal((await getCard(CARD))!.column, "review", "whatever held the card finishes it; the next poll settles the rest");
  });

  it("does not finish a card twice when it merges while an Approve is under way", async () => {
    const approving = approveCard(CARD, { kind: "user", id: "bea" }, HEAD_A);
    const polled = reconcileCard(CARD);
    await Promise.all([approving, polled]);

    assert.equal((await getCard(CARD))!.column, "done");
    assert.equal((await events("card.merged")).length, 1);
    assert.equal((await comments()).length, 1);
  });
});

describe("reading a card again when someone opens it", () => {
  it("asks GitHub at most once every half minute per card", async () => {
    github.pulls.get(7)!.sha = HEAD_B;
    const res = await api.request(`/cards/${CARD}/sync`, { method: "POST", headers: { "x-dev-user": "ada@example.com" } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { prHeadSha: string }).prHeadSha, HEAD_B);

    github.requests.length = 0;
    assert.equal(await reconcileOnDemand(CARD), "recent");
    assert.deepEqual(github.requests, []);
  });

  it("is refused to someone who cannot open the board", async () => {
    await db.insert(schema.users).values({ id: "eve", email: "eve@example.com", handle: "eve", name: "Eve", role: "member", status: "active" });
    const res = await api.request(`/cards/${CARD}/sync`, { method: "POST", headers: { "x-dev-user": "eve@example.com" } });
    assert.equal(res.status, 403);
  });
});
