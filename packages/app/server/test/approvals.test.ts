import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { githubAppEnv, installFakeGitHub } from "./fake-github.js";

// The database module opens its file at import time, and the GitHub merge App is read from the
// environment at import time, so both are set first. Everything the app would send to GitHub is
// answered by the fake in fake-github.ts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-approvals-"));
process.env.KARDBOARD_DATA_DIR = root;
// These tests sign in with dev authentication, whatever a local .env chooses.
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
// A merge GitHub is still thinking about is asked again after this long, and twice as long after that.
process.env.KARDBOARD_MERGE_RECHECK_MS = "5";
githubAppEnv();

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { ApprovalError, approveCard, followUpFor, linkPullRequest, listApprovals, retryMerge } = await import("../src/services/approvals.js");
const { getCard, updateCard } = await import("../src/services/cards.js");
const { createComment } = await import("../src/services/comments.js");
const { classifyMergeRefusal, summarizeChecks } = await import("../src/services/github.js");
const { api } = await import("../src/routes/api.js");
const { mcp } = await import("../src/routes/mcp.js");

await runMigrations();

const REPO = "acme/widgets";
const BRANCH = "kardboard/card-1-the-change";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const github = installFakeGitHub(REPO);

// ---- the MCP server, reached the way a Session reaches it ----

const server = serve({ fetch: mcp.fetch, port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);

after(() => {
  server.close();
  github.restore();
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
  github.reset();
  await db.insert(schema.boards).values({ id: "board-1", slug: "board-one", name: "Board one", repoUrl: `https://github.com/${REPO}` });
  await db.insert(schema.users).values({ id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" });
  await db.insert(schema.users).values({ id: "root", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" });
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

describe("approving while the Agent has work on the card still to start", () => {
  const pending = async () => (await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, CARD))).map((t) => `${t.kind}:${t.status}`);

  it("is refused while a change request waits for a session, and the request is kept", async () => {
    await linkPullRequest(CARD, { number: 7 });
    await createComment({ cardId: CARD, actor: MEMBER, body: "Please also rename the button" });

    await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), (err: unknown) => err instanceof ApprovalError && err.status === 409 && err.message === "Milo hasn't read the latest comment yet. Approve once it has.");

    assert.deepEqual(github.merges, []);
    assert.deepEqual(await listApprovals(CARD), []);
    assert.deepEqual(await pending(), ["comment_posted:pending"], "the comment still gets its session");
    assert.equal((await getCard(CARD))!.column, "review");
  });

  it("is refused while an edit waits on a paused board", async () => {
    await linkPullRequest(CARD, { number: 7 });
    await db.update(schema.boards).set({ paused: true }).where(eq(schema.boards.id, "board-1"));
    const card = (await getCard(CARD))!;
    await updateCard(CARD, { description: "Also the footer.", revision: card.revision, actor: MEMBER });

    await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), /hasn't read the latest edit to this card yet/);
    assert.deepEqual(github.merges, []);
  });

  it("is refused when a comment arrives while GitHub is being asked", async () => {
    await linkPullRequest(CARD, { number: 7 });
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/check-runs")) await createComment({ cardId: CARD, actor: MEMBER, body: "Wait, one more thing" });
      return fake(input, init);
    }) as typeof fetch;
    try {
      await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), /hasn't read the latest comment yet/);
    } finally {
      globalThis.fetch = fake;
    }
    assert.deepEqual(github.merges, []);
    assert.deepEqual(await listApprovals(CARD), []);
  });

  it("refuses a merge retry the same way, through the API", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.refusal = { status: 403, message: "Resource not accessible by integration" };
    await approveCard(CARD, MEMBER, HEAD_A);
    github.refusal = null;
    await createComment({ cardId: CARD, actor: MEMBER, body: "Actually, hold on" });

    const res = await api.request(`/cards/${CARD}/retry-merge`, { method: "POST", headers: { "x-dev-user": "ada@example.com" } });

    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "Milo hasn't read the latest comment yet. Try the merge again once it has.");
    assert.deepEqual(github.merges, []);
    assert.deepEqual(await pending(), ["comment_posted:pending"]);
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
    assert.match(followUp.kind === "refused" ? followUp.comment : "", /Try merging again/);
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

describe("retrying a merge GitHub still refuses", () => {
  it("keeps the approval standing with the newer refusal, and the card in Review", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.refusal = { status: 403, message: "Resource not accessible by integration" };
    await approveCard(CARD, MEMBER, HEAD_A);
    github.refusal = { status: 422, message: "Rate limited" };

    const approval = await retryMerge(CARD, MEMBER);

    assert.equal(approval.invalidatedAt, null);
    assert.equal(approval.mergeError, "422 Rate limited");
    assert.deepEqual(github.merges, []);
    assert.equal((await getCard(CARD))!.column, "review");
    assert.equal(approvalAwaitingRetry(await listApprovals(CARD))?.id, approval.id, "the card still offers a retry");
  });
});

describe("a 405 from GitHub's merge", () => {
  it("is asked again while GitHub is still working out mergeability, and then merges", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({ status: 405, message: "Pull Request is not mergeable", then: (p) => (p.mergeable = null) });

    await approveCard(CARD, MEMBER, HEAD_A);

    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
    assert.equal((await getCard(CARD))!.column, "done");
  });

  it("is asked again when the base branch moved a moment ago", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({ status: 405, message: "Base branch was modified. Review and try the merge again." });

    await approveCard(CARD, MEMBER, HEAD_A);

    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
  });

  it("leaves the approval standing and offers a retry when GitHub is still computing after asking again", async () => {
    await linkPullRequest(CARD, { number: 7 });
    const computing = { status: 405, message: "Pull Request is not mergeable", then: (p: { mergeable?: boolean | null }) => (p.mergeable = null) };
    github.mergeReplies.push(computing, computing, computing);

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(approval.invalidatedAt, null, "nothing is wrong with the pull request, so the approval stands");
    assert.match(approval.mergeError ?? "", /still checking/);
    assert.deepEqual(github.merges, []);
    assert.equal((await getCard(CARD))!.column, "review");
    const triggers = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, CARD));
    assert.deepEqual(triggers, [], "no session is sent to change a branch that needs no change");

    github.pulls.get(7)!.mergeable = true;
    await retryMerge(CARD, MEMBER);
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
  });

  it("voids the approval and sends a session to update a branch with conflicts", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({
      status: 405,
      message: "Merge conflict",
      then: (p) => {
        p.mergeable = false;
        p.mergeableState = "dirty";
      },
    });

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.notEqual(approval.invalidatedAt, null);
    const triggers = await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, CARD));
    assert.deepEqual(
      triggers.map((t) => t.kind),
      ["approval"],
    );
  });

  it("leaves the approval standing for a rule of the repository's own", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({ status: 405, message: "Repository rule violations found", then: (p) => (p.mergeableState = "blocked") });

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(approval.invalidatedAt, null);
    assert.equal(approval.mergeError, "405 Repository rule violations found");
  });

  it("is sorted by what GitHub says of the pull request, not by the status alone", () => {
    assert.equal(classifyMergeRefusal("Pull Request is not mergeable", { mergeable: null, mergeableState: "unknown" }), "retry");
    assert.equal(classifyMergeRefusal("Base branch was modified. Review and try the merge again.", { mergeable: true, mergeableState: "behind" }), "retry");
    assert.equal(classifyMergeRefusal("Pull Request is not mergeable", { mergeable: false, mergeableState: "dirty" }), "conflict");
    assert.equal(classifyMergeRefusal("Head branch is out of date", { mergeable: true, mergeableState: "behind" }), "conflict");
    assert.equal(classifyMergeRefusal("At least 1 approving review is required", { mergeable: true, mergeableState: "blocked" }), "refused");
  });

  it("is not taken for GitHub still checking when the pull request was closed, or could not be read again", () => {
    assert.equal(classifyMergeRefusal("Pull Request is not mergeable", { state: "closed", merged: false, mergeable: null, mergeableState: "unknown" }), "closed");
    assert.equal(classifyMergeRefusal("Pull Request is not mergeable", null), "refused");
    assert.equal(classifyMergeRefusal("Base branch was modified. Review and try the merge again.", null), "retry", "GitHub's own words still say to ask again");
    assert.equal(classifyMergeRefusal("Merge conflict", null), "conflict");
  });

  it("voids the approval, without asking again, when the pull request was closed meanwhile", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({
      status: 405,
      message: "Pull Request is not mergeable",
      then: (p) => {
        p.state = "closed";
        p.closedAt = "2026-09-24T10:00:00.000Z";
        p.mergeable = null;
      },
    });

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.notEqual(approval.invalidatedAt, null);
    assert.equal(approval.mergeError, null);
    assert.equal(github.requests.filter((r) => r.endsWith("/merge")).length, 1);
    const said = (await db.select().from(schema.comments).where(eq(schema.comments.cardId, CARD))).map((c) => c.body);
    assert.deepEqual(said, ["@ada Pull request #7 was closed on GitHub before it could merge, so nothing was merged."]);
    assert.deepEqual(await db.select().from(schema.triggers).where(eq(schema.triggers.cardId, CARD)), [], "no session is sent to a closed pull request");
  });

  it("reports GitHub's refusal as it was when the pull request cannot be read again", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.mergeReplies.push({ status: 405, message: "Pull Request is not mergeable", then: () => github.pulls.delete(7) });

    const approval = await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(approval.invalidatedAt, null);
    assert.equal(approval.mergeError, "405 Pull Request is not mergeable");
    assert.equal(github.requests.filter((r) => r.endsWith("/merge")).length, 1, "not asked again as if GitHub were still checking");
  });
});

describe("a pull request's checks", () => {
  const run = (name: string, conclusion: string | null, status = conclusion ? "completed" : "in_progress") => ({ name, status, conclusion, url: null });

  it("are summed up as one state", () => {
    assert.deepEqual(summarizeChecks({ runs: [run("build", "success"), run("lint", "skipped")], statuses: [] }), { state: "passing", total: 2, failed: 0, pending: 0 });
    assert.deepEqual(summarizeChecks({ runs: [run("build", "success"), run("test", null)], statuses: [] }), { state: "pending", total: 2, failed: 0, pending: 1 });
    assert.deepEqual(summarizeChecks({ runs: [run("build", "failure"), run("test", null)], statuses: [run("deploy", "error")] }), { state: "failing", total: 3, failed: 2, pending: 1 });
    assert.deepEqual(summarizeChecks({ runs: [], statuses: [] }), { state: "none", total: 0, failed: 0, pending: 0 });
  });

  it("are unknown when either half cannot be read, unless something visibly failed", () => {
    assert.equal(summarizeChecks({ runs: null, statuses: [run("ci", "success")] }).state, "unknown");
    assert.equal(summarizeChecks({ runs: [run("build", "success")], statuses: null }).state, "unknown");
    assert.equal(summarizeChecks({ runs: [run("build", "cancelled")], statuses: null }).state, "failing");
  });
});

describe("approving over the checks", () => {
  const approve = (email: string, body: Record<string, unknown>) =>
    api.request(`/cards/${CARD}/approve`, { method: "POST", headers: { "x-dev-user": email, "content-type": "application/json" }, body: JSON.stringify({ headSha: HEAD_A, ...body }) });

  it("is refused while a check is failing, and the card shows why", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ]);

    await assert.rejects(approveCard(CARD, MEMBER, HEAD_A), (err: unknown) => err instanceof ApprovalError && err.status === 409 && /1 of 2 checks failed/.test(err.message));

    assert.deepEqual(github.merges, []);
    assert.deepEqual(await listApprovals(CARD), []);
    const checks = (await getCard(CARD))!.checks;
    assert.equal(checks?.state, "failing");
    assert.equal(checks?.sha, HEAD_A);
  });

  it("merges over failing checks when the Admin overrides, and records that they did", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, [{ name: "test", status: "completed", conclusion: "failure" }]);

    const res = await approve("root@example.com", { overrideChecks: true });

    assert.equal(res.status, 201);
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
    const approved = await db.select().from(schema.events).where(eq(schema.events.type, "card.approved")).get();
    assert.equal(approved?.payload.overrideChecks, true);
    assert.equal(approved?.payload.checks, "failing");
  });

  it("ignores a member's request to override", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, [{ name: "test", status: "completed", conclusion: "failure" }]);

    const res = await approve("ada@example.com", { overrideChecks: true });

    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /The check failed/);
    assert.deepEqual(github.merges, []);
  });

  it("merges when the checks cannot be read", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, 403);

    await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(github.merges.length, 1);
  });

  it("merges while checks are still running; warning about that is the client's job", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, [{ name: "test", status: "in_progress", conclusion: null }]);

    await approveCard(CARD, MEMBER, HEAD_A);

    assert.equal(github.merges.length, 1);
  });

  it("gates a retry the same way", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.refusal = { status: 403, message: "Resource not accessible by integration" };
    await approveCard(CARD, MEMBER, HEAD_A);
    github.refusal = null;
    github.checkRuns.set(HEAD_A, [{ name: "test", status: "completed", conclusion: "failure" }]);

    await assert.rejects(retryMerge(CARD, MEMBER), /The check failed/);
    assert.deepEqual(github.merges, []);

    await retryMerge(CARD, { kind: "user", id: "root" }, { overrideChecks: true });
    assert.deepEqual(github.merges, [{ number: 7, sha: HEAD_A }]);
  });
});

describe("get_checks", () => {
  it("reads the checks on the head the session last pushed, and records them on the card", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.pulls.get(7)!.sha = HEAD_B;
    github.checkRuns.set(HEAD_B, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ]);
    github.statuses.set(HEAD_B, [{ context: "deploy/preview", state: "pending" }]);
    const session = await sessionOn(CARD);
    try {
      const result = await session.callTool({ name: "get_checks", arguments: {} });
      assert.notEqual(result.isError, true);
      const out = JSON.parse(text(result)) as { state: string; sha: string; checks: { name: string; status: string; conclusion: string | null; url: string | null }[] };
      assert.equal(out.state, "failing");
      assert.equal(out.sha, HEAD_B);
      assert.deepEqual(
        out.checks.map((c) => [c.name, c.status, c.conclusion]),
        [
          ["build", "completed", "success"],
          ["test", "completed", "failure"],
          ["deploy/preview", "pending", null],
        ],
      );
      assert.ok(out.checks.every((c) => c.url));
      const card = (await getCard(CARD))!;
      assert.equal(card.prHeadSha, HEAD_B);
      assert.deepEqual([card.checks?.state, card.checks?.failed, card.checks?.pending, card.checks?.total], ["failing", 1, 1, 3]);
    } finally {
      await session.close();
    }
  });

  it("says unknown rather than failing when GitHub will not show the checks", async () => {
    await linkPullRequest(CARD, { number: 7 });
    github.checkRuns.set(HEAD_A, 403);
    github.statuses.set(HEAD_A, 404);
    const session = await sessionOn(CARD);
    try {
      const out = JSON.parse(text(await session.callTool({ name: "get_checks", arguments: {} }))) as { state: string; checks: unknown[] };
      assert.equal(out.state, "unknown");
      assert.deepEqual(out.checks, []);
    } finally {
      await session.close();
    }
  });

  it("asks for the pull request first when none is recorded or open", async () => {
    github.pulls.delete(7);
    const session = await sessionOn(CARD);
    try {
      const result = await session.callTool({ name: "get_checks", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(text(result), /set_work_state/);
    } finally {
      await session.close();
    }
  });
});
