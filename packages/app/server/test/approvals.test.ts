import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { approvalAwaitingRetry, type Approval } from "@kardboard/shared";

// The database module opens its file at import time, and the GitHub merge App is read from the
// environment at import time, so both are set first. The App's key is real because the app signs
// its JWT with it; everything it would send to GitHub is answered by the fake below.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-approvals-"));
process.env.KARDBOARD_DATA_DIR = root;
// These tests sign in with dev authentication, whatever a local .env chooses.
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.env.GITHUB_MERGE_APP_ID = "1";
process.env.GITHUB_MERGE_APP_PRIVATE_KEY_B64 = Buffer.from(privateKey).toString("base64");

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { ApprovalError, approveCard, followUpFor, linkPullRequest, listApprovals, retryMerge } = await import("../src/services/approvals.js");
const { getCard } = await import("../src/services/cards.js");
const { api } = await import("../src/routes/api.js");
const { mcp } = await import("../src/routes/mcp.js");

await runMigrations();

const REPO = "acme/widgets";
const BRANCH = "kardboard/card-1-the-change";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

// ---- a fake GitHub, just enough of the REST API for pull requests and merges ----

interface FakePull {
  ref: string;
  repo: string | null;
  sha: string;
  state: "open" | "closed";
}
// `refusal` makes the next merges fail the way GitHub does for a reason of its own, such as a failing required check.
const github = { pulls: new Map<number, FakePull>(), merges: [] as { number: number; sha: string }[], refusal: null as { status: number; message: string } | null };

function pullJson(number: number, p: FakePull) {
  return { number, html_url: `https://github.com/${REPO}/pull/${number}`, title: "The change", body: "What it does.", head: { sha: p.sha, ref: p.ref, repo: p.repo ? { full_name: p.repo } : null }, state: p.state, merged: false, mergeable: true, mergeable_state: "clean" };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api.github.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const reply = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
  if (url.pathname === `/repos/${REPO}/installation`) return reply(200, { id: 42 });
  if (url.pathname === "/app/installations/42/access_tokens") return reply(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (url.pathname === `/repos/${REPO}/pulls` && method === "GET") {
    const head = url.searchParams.get("head");
    const open = [...github.pulls].filter(([, p]) => p.state === "open" && p.repo === REPO && `acme:${p.ref}` === head);
    return reply(200, open.map(([n, p]) => pullJson(n, p)));
  }
  let m = new RegExp(`^/repos/${REPO}/pulls/(\\d+)$`).exec(url.pathname);
  if (m && method === "GET") {
    const p = github.pulls.get(Number(m[1]));
    return p ? reply(200, pullJson(Number(m[1]), p)) : reply(404, { message: "Not Found" });
  }
  m = new RegExp(`^/repos/${REPO}/pulls/(\\d+)/merge$`).exec(url.pathname);
  if (m && method === "PUT") {
    const number = Number(m[1]);
    const p = github.pulls.get(number)!;
    const { sha } = JSON.parse(String(init?.body)) as { sha: string };
    if (github.refusal) return reply(github.refusal.status, { message: github.refusal.message });
    if (sha !== p.sha) return reply(409, { message: "Head branch was modified. Review and try the merge again." });
    github.merges.push({ number, sha });
    p.state = "closed";
    return reply(200, { merged: true, sha: "c".repeat(40) });
  }
  if (url.pathname.startsWith(`/repos/${REPO}/git/refs/heads/`) && method === "DELETE") return reply(204, null);
  return reply(404, { message: `the fake GitHub has no ${method} ${url.pathname}` });
}) as typeof fetch;

// ---- the MCP server, reached the way a Session reaches it ----

const server = serve({ fetch: mcp.fetch, port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);

after(() => {
  server.close();
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

async function sessionOn(cardId: string): Promise<Client> {
  const token = `token-${cardId}-${Date.now()}`;
  await db.insert(schema.sessions).values({ id: `session-${cardId}`, boardId: "board-1", cardId, kind: "card", provider: "claude", status: "running", branch: BRANCH, tokenHash: createHash("sha256").update(token).digest("hex") });
  const client = new Client({ name: "test-session", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

// ---- fixtures ----

const CARD = "card-1";
const MEMBER = { kind: "user" as const, id: "ada" };

beforeEach(async () => {
  for (const t of [schema.approvals, schema.sessions, schema.triggers, schema.events, schema.notifications, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  github.pulls.clear();
  github.merges.length = 0;
  github.refusal = null;
  await db.insert(schema.boards).values({ id: "board-1", slug: "board-one", name: "Board one", repoUrl: `https://github.com/${REPO}` });
  await db.insert(schema.users).values({ id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" });
  await db.insert(schema.boardMembers).values({ boardId: "board-1", userId: "ada" });
  await db.insert(schema.cards).values({ id: CARD, boardId: "board-1", title: "The change", column: "review", creatorKind: "user", creatorId: "ada", branch: BRANCH });
  // The Card's own pull request, another Card's, and a fork's with the same branch name.
  github.pulls.set(7, { ref: BRANCH, repo: REPO, sha: HEAD_A, state: "open" });
  github.pulls.set(8, { ref: "kardboard/card-2-something-else", repo: REPO, sha: "d".repeat(40), state: "open" });
  github.pulls.set(9, { ref: BRANCH, repo: "mallory/widgets", sha: "e".repeat(40), state: "open" });
});

describe("a Session reporting its pull request", () => {
  it("records the card's own pull request with the head GitHub has, not the Session's word", async () => {
    await linkPullRequest(CARD, { number: 7, url: "https://example.com/looks-like-a-pr" });
    const card = (await getCard(CARD))!;
    assert.equal(card.prNumber, 7);
    assert.equal(card.prUrl, `https://github.com/${REPO}/pull/7`);
    assert.equal(card.prHeadSha, HEAD_A);
  });

  it("refuses another card's pull request", async () => {
    await assert.rejects(linkPullRequest(CARD, { number: 8 }), /not this card's branch/);
    assert.equal((await getCard(CARD))!.prNumber, null);
  });

  it("refuses a fork's pull request that borrowed the branch name", async () => {
    await assert.rejects(linkPullRequest(CARD, { url: `https://github.com/${REPO}/pull/9` }), /comes from mallory\/widgets/);
    assert.equal((await getCard(CARD))!.prNumber, null);
  });

  it("voids an Approval that stood on an older head", async () => {
    await linkPullRequest(CARD, { number: 7 });
    await db.insert(schema.approvals).values({ id: "approval-1", cardId: CARD, userId: "ada", prNumber: 7, headSha: HEAD_A });
    github.pulls.get(7)!.sha = HEAD_B;

    await linkPullRequest(CARD, { number: 7 });

    const approval = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, "approval-1")).get())!;
    assert.notEqual(approval.invalidatedAt, null);
  });
});

describe("the MCP tools a Session uses", () => {
  it("set_work_state refuses a pull request from another branch and records its own", async () => {
    const session = await sessionOn(CARD);
    try {
      const refused = await session.callTool({ name: "set_work_state", arguments: { pr_number: 8 } });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /not this card's branch/);

      const recorded = await session.callTool({ name: "set_work_state", arguments: { pr_number: 7 } });
      assert.notEqual(recorded.isError, true);
      assert.equal(JSON.parse(text(recorded)).headSha, HEAD_A);
    } finally {
      await session.close();
    }
  });

  it("move_card refuses a revision the card has moved on from, and records the head on entering Review", async () => {
    await db.update(schema.cards).set({ column: "in_progress", prNumber: 7, prHeadSha: HEAD_A }).where(eq(schema.cards.id, CARD));
    const seen = (await getCard(CARD))!.revision;
    github.pulls.get(7)!.sha = HEAD_B;
    const session = await sessionOn(CARD);
    try {
      await db.update(schema.cards).set({ revision: seen + 1 }).where(eq(schema.cards.id, CARD));
      const stale = await session.callTool({ name: "move_card", arguments: { column: "review", revision: seen } });
      assert.equal(stale.isError, true);
      assert.match(text(stale), /changed after revision/);

      const moved = await session.callTool({ name: "move_card", arguments: { column: "review", revision: seen + 1 } });
      assert.notEqual(moved.isError, true);
      const card = (await getCard(CARD))!;
      assert.equal(card.column, "review");
      assert.equal(card.prHeadSha, HEAD_B, "the head pushed after the report is the one a member is shown");
    } finally {
      await session.close();
    }
  });
});

describe("approving a card", () => {
  it("merges the head the member was shown, with that head as GitHub's precondition", async () => {
    await linkPullRequest(CARD, { number: 7 });

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(approval.headSha, HEAD_A);
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
    const card = (await getCard(CARD))!;
    assert.equal(card.column, "done");
    assert.equal(card.outcome, "implemented");
  });

  it("refuses when the pull request moved on after the member looked, and shows them the new head", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.pulls.get(7)!.sha = HEAD_B;

    await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /moved on from aaaaaaa to bbbbbbb/.test(err.message));
    assert.deepEqual(github.merges, []);
    const card = (await getCard(CARD))!;
    assert.equal(card.column, "review");
    assert.equal(card.prHeadSha, HEAD_B);
  });

  it("refuses a card pointed at another card's pull request", async () => {
    await db.update(schema.cards).set({ prNumber: 8 }).where(eq(schema.cards.id, CARD));
    await assert.rejects(approveCard(CARD, MEMBER, "d".repeat(40)), /not this card's branch/);
    assert.deepEqual(github.merges, []);
  });

  it("refuses while a Session is still working on the card", async () => {
    await linkPullRequest(CARD, { number: 7 });
    await db.insert(schema.sessions).values({ id: "session-busy", boardId: "board-1", cardId: CARD, kind: "card", provider: "claude", status: "running" });

    await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), /still working on this card/);
    assert.deepEqual(github.merges, []);
  });

  it("gives the member the reason as text through the API", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.pulls.get(7)!.sha = HEAD_B;

    const res = await api.request(`/cards/${CARD}/approve`, { method: "POST", headers: { "x-dev-user": "ada@example.com", "content-type": "application/json" }, body: JSON.stringify({ headSha: HEAD_A }) });

    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /moved on/);
    assert.deepEqual(github.merges, []);
  });
});

describe("what a merge outcome means for the approval it was made on", () => {
  it("merges", () => {
    assert.deepEqual(followUpFor({ ok: true, sha: "abc" }, 7, "@ada"), { kind: "merged", sha: "abc" });
  });

  it("voids the approval when the head moved, and asks for a fresh look rather than a retry", () => {
    const followUp = followUpFor({ ok: false, reason: "head_changed", message: "head changed" }, 7, "@ada");
    assert.equal(followUp.kind, "invalidated");
    assert.equal(followUp.kind === "invalidated" && followUp.rerun, false);
    assert.match(followUp.kind === "invalidated" ? followUp.comment : "", /approve once more/);
  });

  it("voids the approval and sends a session to update a branch that cannot merge", () => {
    const followUp = followUpFor({ ok: false, reason: "not_mergeable", message: "not mergeable" }, 7, "@ada");
    assert.equal(followUp.kind, "invalidated");
    assert.equal(followUp.kind === "invalidated" && followUp.rerun === true ? followUp.reason : "", "not mergeable");
  });

  it("keeps the approval standing for a refusal of GitHub's own, and offers a retry", () => {
    const followUp = followUpFor({ ok: false, reason: "error", message: "403 Required status check is failing" }, 7, "@ada");
    assert.equal(followUp.kind, "refused");
    assert.equal(followUp.kind === "refused" ? followUp.error : "", "403 Required status check is failing");
    assert.match(followUp.kind === "refused" ? followUp.comment : "", /Retry merge/);
  });
});

describe("the approval a card offers a retry on", () => {
  const approval = (fields: Partial<Approval>): Approval => ({
    id: `a-${Math.random()}`,
    cardId: CARD,
    userId: "ada",
    prNumber: 7,
    headSha: HEAD_A,
    createdAt: "2026-09-15T04:00:00.000Z",
    invalidatedAt: null,
    mergeError: null,
    ...fields,
  });

  it("is the standing one whose merge GitHub refused", () => {
    const refused = approval({ mergeError: "403 Resource not accessible" });
    assert.equal(approvalAwaitingRetry([approval({}), refused])?.id, refused.id);
  });

  it("is nothing when no merge was refused, or the refusal voided the approval", () => {
    assert.equal(approvalAwaitingRetry([approval({})]), null);
    assert.equal(approvalAwaitingRetry([]), null);
    assert.equal(approvalAwaitingRetry([approval({ mergeError: "403", invalidatedAt: "2026-09-15T04:05:00.000Z" })]), null);
  });

  it("is the newest one, as the server lists them", async () => {
    await db.insert(schema.approvals).values({ id: "old", cardId: CARD, userId: "ada", prNumber: 7, headSha: HEAD_A, createdAt: "2026-09-15T04:00:00.000Z", invalidatedAt: "2026-09-15T04:01:00.000Z" });
    await db.insert(schema.approvals).values({ id: "new", cardId: CARD, userId: "ada", prNumber: 7, headSha: HEAD_A, createdAt: "2026-09-15T04:02:00.000Z", mergeError: "403 Resource not accessible" });
    assert.equal(approvalAwaitingRetry(await listApprovals(CARD))?.id, "new");
  });
});

describe("retrying a merge GitHub refused", () => {
  async function refusedApproval(): Promise<Approval> {
    await linkPullRequest(CARD, { number: 7 });
    github.refusal = { status: 403, message: "Required status check is failing" };
    const approval = await approveCard(CARD, MEMBER, HEAD_A);
    github.refusal = null;
    return approval;
  }

  it("leaves the approval standing with the refusal recorded, and nothing merged", async () => {
    const approval = await refusedApproval();
    assert.equal(approval.invalidatedAt, null);
    assert.equal(approval.mergeError, "403 Required status check is failing");
    assert.deepEqual(github.merges, []);
    assert.equal((await getCard(CARD))!.column, "review");
  });

  it("merges the reviewed head once the cause is fixed, without a second sign-off", async () => {
    await refusedApproval();

    const approval = await retryMerge(CARD, MEMBER);

    assert.equal(approval.mergeError, null);
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
    assert.equal((await getCard(CARD))!.column, "done");
  });

  it("merges nothing when the branch moved after the approval, and asks the member to look again", async () => {
    await refusedApproval();
    github.pulls.get(7)!.sha = HEAD_B;

    const approval = await retryMerge(CARD, MEMBER);

    assert.notEqual(approval.invalidatedAt, null);
    assert.deepEqual(github.merges, []);
    const card = (await getCard(CARD))!;
    assert.equal(card.column, "review");
    assert.equal(card.prHeadSha, HEAD_B);
  });

  it("refuses when no approval is waiting on a refused merge", async () => {
    await linkPullRequest(CARD, { number: 7 });
    await db.insert(schema.approvals).values({ id: "voided", cardId: CARD, userId: "ada", prNumber: 7, headSha: HEAD_A, mergeError: "403", invalidatedAt: "2026-09-15T04:05:00.000Z" });
    await assert.rejects(retryMerge(CARD, MEMBER), (err: unknown) => err instanceof ApprovalError && /waiting on a refused merge/.test(err.message));
  });

  it("refuses once the card has left Review", async () => {
    await refusedApproval();
    await db.update(schema.cards).set({ column: "done" }).where(eq(schema.cards.id, CARD));
    await assert.rejects(retryMerge(CARD, MEMBER), /in Review/);
    assert.deepEqual(github.merges, []);
  });

  it("refuses while a Session is working on the card", async () => {
    await refusedApproval();
    await db.insert(schema.sessions).values({ id: "session-busy", boardId: "board-1", cardId: CARD, kind: "card", provider: "claude", status: "running" });
    await assert.rejects(retryMerge(CARD, MEMBER), (err: unknown) => err instanceof ApprovalError && err.status === 409);
    assert.deepEqual(github.merges, []);
  });

  it("needs a signed-in user, since the retry is a member's act", async () => {
    await refusedApproval();
    await assert.rejects(retryMerge(CARD, { kind: "agent", id: null }), /signed-in user/);
  });

  it("is offered to members through the API", async () => {
    await refusedApproval();

    const res = await api.request(`/cards/${CARD}/retry-merge`, { method: "POST", headers: { "x-dev-user": "ada@example.com" } });

    assert.equal(res.status, 200);
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
  });
});
