import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { githubAppEnv, installFakeGitHub } from "./fake-github.js";

// The database module opens its file at import time, so point it at a scratch directory first. A
// runner URL puts the client in http mode, whose methods the tests below replace; the Sessions app
// mints the clone token a build request carries, from the fake GitHub.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-previews-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.cc";
process.env.KARDBOARD_PREVIEW_SECRET = "test-preview-secret";
process.env.KARDBOARD_RUNNER_URL = "http://runner.test";
githubAppEnv(["SESSIONS"]);

const { db, schema, runMigrations } = await import("../src/db/index.js");
const {
  bumpPreviewEpoch,
  exchangePreviewCode,
  issuePreviewCode,
  previewHostFor,
  previewRoutes,
  previewUrlFor,
  reapPreviews,
  applyPreviewState,
  settleBuildsInterruptedBy,
  settleStuckBuilds,
  startPreview,
  INTERRUPTED_BUILD,
  INTERRUPTED_REBUILD,
  verifyPreviewCookie,
} = await import("../src/services/previews.js");
const { getCard } = await import("../src/services/cards.js");
const { runner } = await import("../src/services/runner-client.js");

await runMigrations();
const github = installFakeGitHub("chriscorbell/kardboard");
runner.stopPreview = async () => {};
after(() => {
  github.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

const BOARD = "board-1";
const OTHER_BOARD = "board-2";
const SECRET = "test-preview-secret";

let n = 0;
async function makeUser(role: "admin" | "member" = "member"): Promise<User> {
  const id = `user-${n++}`;
  await db.insert(schema.users).values({ id, email: `${id}@example.com`, handle: id, name: id, role, status: "active" });
  return { ...(await db.select().from(schema.users).where(eq(schema.users.id, id)).get())! } as User;
}

async function makePreview(boardId = BOARD): Promise<{ id: string; host: string; cardId: string }> {
  const cardId = `card-${n++}`;
  const id = `preview-${n++}`;
  await db.insert(schema.cards).values({ id: cardId, boardId, title: "A card", branch: `kardboard/${cardId}` });
  const host = `${cardId}.kardboard.cc`;
  await db.insert(schema.previews).values({ id, boardId, cardId, host, status: "running", branch: `kardboard/${cardId}`, target: `http://kardboard-preview-${id}:3000` });
  return { id, host, cardId };
}

beforeEach(async () => {
  for (const t of [schema.previewCodes, schema.previews, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-1", name: "Board one", previewMode: "runner", repoUrl: "https://github.com/chriscorbell/kardboard" },
    { id: OTHER_BOARD, slug: "board-2", name: "Board two" },
  ]);
});

describe("preview hostnames", () => {
  it("hangs off the app's own parent domain, one host per card", () => {
    assert.equal(previewHostFor("k6u39mjgb5j2w8"), "k6u39mjg.kardboard.cc");
    assert.equal(previewUrlFor("k6u39mjg.kardboard.cc"), "https://k6u39mjg.kardboard.cc");
  });
});

describe("letting a member into a preview", () => {
  it("issues a single-use code that the router spends for a host-only cookie", async () => {
    const preview = await makePreview();
    const user = await makeUser();
    await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: user.id });

    const { code, redirectBase } = await issuePreviewCode(user, preview.host);
    assert.equal(redirectBase, `https://${preview.host}`);

    const { cookie, maxAgeSeconds } = await exchangePreviewCode(code, preview.host);
    const payload = verifyPreviewCookie(cookie, SECRET);
    assert.equal(payload?.host, preview.host);
    assert.equal(payload?.user, user.id);
    assert.equal(payload?.board, BOARD);
    assert.ok(maxAgeSeconds > 0);

    await assert.rejects(exchangePreviewCode(code, preview.host), /already used/, "the same code cannot be spent twice");
  });

  it("lets only one of two simultaneous exchanges spend a code", async () => {
    const preview = await makePreview();
    const user = await makeUser();
    await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: user.id });
    const { code } = await issuePreviewCode(user, preview.host);

    const results = await Promise.allSettled([exchangePreviewCode(code, preview.host), exchangePreviewCode(code, preview.host)]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already used/);
  });

  it("refuses a code aimed at a different preview host", async () => {
    const preview = await makePreview();
    const other = await makePreview();
    const user = await makeUser("admin");
    const { code } = await issuePreviewCode(user, preview.host);
    await assert.rejects(exchangePreviewCode(code, other.host), /different preview/);
  });

  it("refuses a member of another board", async () => {
    const preview = await makePreview();
    const outsider = await makeUser();
    await db.insert(schema.boardMembers).values({ boardId: OTHER_BOARD, userId: outsider.id });
    await assert.rejects(issuePreviewCode(outsider, preview.host), /not a member/);
  });

  it("refuses a code once the user is revoked, even before it is spent", async () => {
    const preview = await makePreview();
    const user = await makeUser();
    await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: user.id });
    const { code } = await issuePreviewCode(user, preview.host);
    await db.update(schema.users).set({ status: "revoked" }).where(eq(schema.users.id, user.id));
    await assert.rejects(exchangePreviewCode(code, preview.host), /no longer open previews/);
  });

  it("refuses a code for a preview that has been removed", async () => {
    const preview = await makePreview();
    const admin = await makeUser("admin");
    const { code } = await issuePreviewCode(admin, preview.host);
    await db.delete(schema.previews).where(eq(schema.previews.id, preview.id));
    await assert.rejects(exchangePreviewCode(code, preview.host), /already used|no preview/);
  });
});

describe("the routing table the preview router polls", () => {
  it("carries the board's epoch, which moves when membership narrows", async () => {
    const preview = await makePreview();
    const before = (await previewRoutes()).find((r) => r.host === preview.host)!;
    assert.equal(before.target, `http://kardboard-preview-${preview.id}:3000`);
    assert.equal(before.status, "running");

    await bumpPreviewEpoch(BOARD);
    const after = (await previewRoutes()).find((r) => r.host === preview.host)!;
    assert.equal(after.epoch, before.epoch + 1, "cookies issued under the old epoch stop working");
  });

  it("reports a failed build with the reason, so the router can show it", async () => {
    const preview = await makePreview();
    await applyPreviewState(preview.id, { status: "failed", error: "Dockerfile is not in the branch" });
    const route = (await previewRoutes()).find((r) => r.host === preview.host)!;
    assert.equal(route.status, "failed");
    assert.equal(route.error, "Dockerfile is not in the branch");
    // The runner leaves the previous container up after a failed rebuild; the router shows the
    // failure anyway, and the next rebuild can serve that container while it runs.
    assert.equal(route.target, `http://kardboard-preview-${preview.id}:3000`);
  });
});

describe("the commit a Preview serves", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const SHA_C = "c".repeat(40);

  it("is recorded when the build runs, and travels on the Card", async () => {
    const preview = await makePreview();
    await applyPreviewState(preview.id, { status: "running", containerId: "c1", target: "http://kardboard-preview-x:3000", sha: SHA_A });
    const card = (await getCard(preview.cardId))!;
    assert.equal(card.preview?.status, "running");
    assert.equal(card.preview?.sha, SHA_A);
    assert.equal(card.preview?.failedSha, null);
    assert.equal(card.preview?.error, null);
  });

  it("stays the commit being served when a rebuild fails, and the failed commit is kept apart", async () => {
    const preview = await makePreview();
    await applyPreviewState(preview.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: SHA_A });
    await applyPreviewState(preview.id, { status: "failed", error: "build failed", sha: SHA_B });
    let card = (await getCard(preview.cardId))!;
    assert.equal(card.preview?.sha, SHA_A, "the previous container is still up, and it is of A");
    assert.equal(card.preview?.failedSha, SHA_B);

    await applyPreviewState(preview.id, { status: "failed", error: "clone failed" });
    card = (await getCard(preview.cardId))!;
    assert.equal(card.preview?.sha, SHA_A);
    assert.equal(card.preview?.failedSha, null, "a clone that failed checked out no commit");

    await applyPreviewState(preview.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: SHA_C });
    card = (await getCard(preview.cardId))!;
    assert.equal(card.preview?.sha, SHA_C);
    assert.equal(card.preview?.failedSha, null);
  });

  it("is absent from a Card with no runner Preview", async () => {
    await db.insert(schema.cards).values({ id: "card-plain", boardId: OTHER_BOARD, title: "No preview" });
    assert.equal((await getCard("card-plain"))!.preview, null);
  });
});

const previewRow = async (id: string) => (await db.select().from(schema.previews).where(eq(schema.previews.id, id)).get())!;

describe("a report from a build the Preview has moved past", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  async function rebuilding(buildId: string) {
    const preview = await makePreview();
    await db.update(schema.previews).set({ status: "building", sha: SHA_A, buildId }).where(eq(schema.previews.id, preview.id));
    return preview;
  }

  it("is ignored, so a replaced build cannot put its failure over the one the Session waits on", async () => {
    const preview = await rebuilding("build-2");
    assert.equal(await applyPreviewState(preview.id, { status: "failed", error: "build failed: exit 1", sha: SHA_B, buildId: "build-1" }), false);
    const row = await previewRow(preview.id);
    assert.equal(row.status, "building");
    assert.equal(row.error, null);
    assert.equal(row.failedSha, null);
  });

  it("is ignored when it succeeded too, so the Session keeps waiting for its own build", async () => {
    const preview = await rebuilding("build-2");
    assert.equal(await applyPreviewState(preview.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: SHA_B, buildId: "build-1" }), false);
    assert.equal((await previewRow(preview.id)).status, "building");

    assert.equal(await applyPreviewState(preview.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: SHA_B, buildId: "build-2" }), true);
    const row = await previewRow(preview.id);
    assert.equal(row.status, "running");
    assert.equal(row.sha, SHA_B);
  });

  it("is believed from a runner too old to send a build id", async () => {
    const preview = await rebuilding("build-2");
    assert.equal(await applyPreviewState(preview.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: SHA_B }), true);
    assert.equal((await previewRow(preview.id)).status, "running");
  });
});

describe("asking the runner for a build", () => {
  const original = runner.startPreview;
  after(() => {
    runner.startPreview = original;
  });

  async function card(): Promise<string> {
    const cardId = `card-${n++}`;
    await db.insert(schema.cards).values({ id: cardId, boardId: BOARD, title: "A card", branch: `kardboard/${cardId}` });
    return cardId;
  }

  it("names the build, and the runner's report of it is the one believed", async () => {
    const requests: { previewId: string; buildId: string }[] = [];
    runner.startPreview = async (req) => void requests.push(req);
    const cardId = await card();
    const first = await startPreview(cardId);
    const second = await startPreview(cardId);
    assert.equal(first.id, second.id);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]!.buildId, requests[1]!.buildId);
    assert.equal(second.buildId, requests[1]!.buildId);

    assert.equal(await applyPreviewState(second.id, { status: "failed", error: "build failed", buildId: requests[0]!.buildId }), false);
    assert.equal(await applyPreviewState(second.id, { status: "running", target: "http://kardboard-preview-x:3000", sha: "d".repeat(40), buildId: requests[1]!.buildId }), true);
  });

  it("records a refused build as failed with no build of its own, so no report or log is taken for it", async () => {
    let lastBuild = "";
    runner.startPreview = async (req) => void (lastBuild = req.buildId);
    const cardId = await card();
    const accepted = await startPreview(cardId);
    const earlier = lastBuild;

    runner.startPreview = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(startPreview(cardId), /the runner refused the build: fetch failed/);
    const row = await previewRow(accepted.id);
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /refused/);
    assert.equal(row.buildId, null);

    assert.equal(await applyPreviewState(accepted.id, { status: "failed", error: "build failed", sha: "e".repeat(40), buildId: earlier }), false, "the earlier build's late report does not replace the refusal");
  });
});

describe("a build nothing will ever report", () => {
  // A Preview made by `makePreview` has a target, so it has a previous build to fall back on; a
  // `first` build has none.
  async function building(minutesAgo: number, opts: { first?: boolean; buildId?: string } = {}): Promise<string> {
    const preview = await makePreview();
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await db
      .update(schema.previews)
      .set({ status: "building", updatedAt: at, buildId: opts.buildId ?? null, ...(opts.first ? { target: null, sha: null } : { sha: "a".repeat(40) }) })
      .where(eq(schema.previews.id, preview.id));
    return preview.id;
  }

  it("fails a first build once it has run past the runner's build limit and the report's retries", async () => {
    const lost = await building(21, { first: true });
    const recent = await building(10, { first: true });
    assert.equal(await settleStuckBuilds(), 1);
    assert.equal((await previewRow(lost)).status, "failed");
    assert.equal((await previewRow(lost)).error, INTERRUPTED_BUILD);
    assert.equal((await previewRow(recent)).status, "building", "a build inside the limit may still finish");
  });

  it("returns a lost rebuild to running, since the previous container still serves", async () => {
    const lost = await building(21);
    assert.equal(await settleStuckBuilds(), 1);
    const row = await previewRow(lost);
    assert.equal(row.status, "running");
    assert.equal(row.error, INTERRUPTED_REBUILD);
    assert.equal(row.sha, "a".repeat(40));
    const route = (await previewRoutes()).find((r) => r.host === row.host)!;
    assert.equal(route.status, "running", "the router keeps serving the old build rather than an error page");
    assert.equal(route.target, `http://kardboard-preview-${lost}:3000`);
  });

  it("is settled as soon as a restarted runner says when it started, except the builds it accepted itself", async () => {
    const before = await building(2, { first: true, buildId: "build-lost" });
    const rebuild = await building(2, { buildId: "build-lost-too" });
    const reached = await building(2, { first: true, buildId: "build-accepted" });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const since = await building(0, { first: true, buildId: "build-new" });
    assert.equal(await settleBuildsInterruptedBy(startedAt, ["build-accepted"]), 2);
    assert.equal((await previewRow(before)).status, "failed");
    assert.equal((await previewRow(rebuild)).status, "running");
    assert.equal((await previewRow(reached)).status, "building", "the new runner has that one");
    assert.equal((await previewRow(since)).status, "building", "and that one, requested since");
  });

  it("leaves Previews that are running or already failed alone", async () => {
    const running = await makePreview();
    await db.update(schema.previews).set({ updatedAt: new Date(Date.now() - 86_400_000).toISOString() }).where(eq(schema.previews.id, running.id));
    assert.equal(await settleStuckBuilds(), 0);
    assert.equal((await previewRow(running.id)).status, "running");
  });

  it("puts itself right if the build it gave up on reports after all", async () => {
    const id = await building(0, { first: true, buildId: "build-late" });
    await settleBuildsInterruptedBy(new Date(Date.now() + 1_000).toISOString());
    assert.equal((await previewRow(id)).status, "failed");
    await applyPreviewState(id, { status: "running", target: "http://kardboard-preview-x:3000", sha: "c".repeat(40), buildId: "build-late" });
    assert.equal((await previewRow(id)).status, "running");
    assert.equal((await previewRow(id)).error, null);
  });
});

describe("removing previews", () => {
  it("takes down a preview whose card reached Done, and one nobody has opened in the idle window", async () => {
    const done = await makePreview();
    const idle = await makePreview();
    const fresh = await makePreview();
    await db.update(schema.cards).set({ column: "done" }).where(eq(schema.cards.id, done.cardId));
    await db
      .update(schema.previews)
      .set({ lastAccessAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })
      .where(eq(schema.previews.id, idle.id));

    const removed = await reapPreviews();
    assert.equal(removed, 2);
    const left = await db.select().from(schema.previews);
    assert.deepEqual(
      left.map((p) => p.id),
      [fresh.id],
    );
  });

  it("drops expired sign-in codes as it goes", async () => {
    const preview = await makePreview();
    const user = await makeUser("admin");
    await issuePreviewCode(user, preview.host);
    await db.update(schema.previewCodes).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await reapPreviews();
    assert.equal((await db.select().from(schema.previewCodes)).length, 0);
  });
});
