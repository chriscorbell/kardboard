import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-previews-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.cc";
process.env.KARDBOARD_PREVIEW_SECRET = "test-preview-secret";

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
  verifyPreviewCookie,
} = await import("../src/services/previews.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

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
    assert.equal(route.target, null);
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
