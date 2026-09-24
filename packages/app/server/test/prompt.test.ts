import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-prompt-"));
process.env.KARDBOARD_DATA_DIR = root;

const { schema, runMigrations } = await import("../src/db/index.js");
const { buildSessionPrompt } = await import("../src/services/prompt.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

type BoardRow = typeof schema.boards.$inferSelect;
type CardRow = typeof schema.cards.$inferSelect;
type TriggerRow = typeof schema.triggers.$inferSelect;

const at = "2026-09-24T10:00:00.000Z";
const board = (previewMode: "runner" | "external" = "runner"): BoardRow => ({ id: "board-1", slug: "board-one", name: "Board one", repoUrl: "https://github.com/acme/widgets", provider: "claude", model: null, reasoning: null, previewMode, previewEpoch: 1, agentImage: null, maxConcurrentSessions: 3, promptAppend: "", createdAt: at });
const card: CardRow = { id: "card-1", boardId: "board-1", title: "Export invoices", description: "", priority: "none", column: "review", position: 1000, creatorKind: "user", creatorId: "ada", parentCardId: null, outcome: null, revision: 4, branch: "kardboard/card-1-export-invoices", prUrl: null, prNumber: 7, prHeadSha: null, previewUrl: null, pendingRerun: false, createdAt: at, updatedAt: at };
const trigger = (kind: string, payload: Record<string, unknown> = {}): TriggerRow => ({ id: `t-${kind}`, boardId: "board-1", cardId: "card-1", kind, actorUserId: "ada", payload, status: "consumed", sessionId: "s-1", createdAt: at });

const prompt = (triggers: TriggerRow[], mode: "runner" | "external" = "runner") => buildSessionPrompt({ board: board(mode), card, sessionId: "s-1", triggers });

describe("the workflow every card Session follows", () => {
  it("moves the card to In Progress when implementation starts", async () => {
    assert.match(await prompt([trigger("comment_posted")]), /Move the card to In Progress when you start implementing/);
  });

  it("reads review comments on GitHub, checks CI after pushing, and retries a flaky acceptance run once", async () => {
    const text = await prompt([trigger("comment_posted")]);
    assert.match(text, /gh pr view <number> --comments/);
    assert.match(text, /pulls\/<number>\/comments/);
    assert.match(text, /After each push, call get_checks/);
    assert.match(text, /run it once more; if it fails again, say so plainly/);
  });

  it("waits for a runner preview and fixes a failed build before reporting", async () => {
    assert.match(await prompt([trigger("comment_posted")]), /call preview_status about once a minute until it is no longer building/);
    assert.doesNotMatch(await prompt([trigger("comment_posted")], "external"), /preview_status/);
  });

  it("always ends with finish, noise included, since a silent exit is recorded as a failure", async () => {
    const text = await prompt([trigger("comment_edited")]);
    assert.match(text, /If it is noise, post nothing and go straight to finish/);
    assert.match(text, /8\. End by calling finish with a one-sentence outcome\. Always call it/);
  });

  it("treats an LGTM comment as a pointer to the Approve button", async () => {
    assert.match(await prompt([trigger("comment_posted")]), /"LGTM" or "approved" is not an Approval/);
  });
});

describe("what a Session is told about its triggers", () => {
  it("explains a retry, says how the last session ended, and sends the Session to the card's earlier sessions first", async () => {
    const text = await prompt([trigger("retry_requested", { sessionId: "s-0", status: "timed_out", outcomeSummary: "Session hit its 45-minute wall clock." })]);
    assert.match(text, /asked to try again after the previous session on this card failed\. It ran out of time: Session hit its 45-minute wall clock\./);
    assert.match(text, /earlier sessions with get_card/);
    assert.match(await prompt([trigger("retry_requested", { sessionId: "s-0", status: "failed", outcomeSummary: null })]), /failed\. It failed\. Read the card's earlier sessions/);
    assert.doesNotMatch(await prompt([trigger("comment_posted")]), /asked to try again/);
  });

  it("walks a Session through an Approval GitHub would not merge", async () => {
    const text = await prompt([trigger("approval", { approvalId: "ap-1", reason: "Pull Request is not mergeable" })]);
    assert.match(text, /would not merge its pull request as it stands \(Pull Request is not mergeable\)/);
    assert.match(text, /Merge the default branch into the card's branch/);
    assert.match(text, /set_work_state\. Request the preview again/);
    assert.match(text, /move the card back to Review/);
  });

  it("says nothing of a refused merge for an Approval that was not refused", async () => {
    assert.doesNotMatch(await prompt([trigger("approval", { approvalId: "ap-1" })]), /would not merge/);
  });
});
