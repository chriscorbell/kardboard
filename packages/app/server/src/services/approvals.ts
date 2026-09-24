import { eq } from "drizzle-orm";
import type { Approval } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { recordEvent, type Actor } from "./events.js";
import { getCard } from "./cards.js";
import { closeCardWork, enqueueTrigger } from "./orchestrator.js";
import { publish } from "./realtime.js";
import { getBoardById } from "./boards.js";
import { createComment } from "./comments.js";
import { moveCard, setCardWorkState } from "./cards.js";
import { getUser } from "./users.js";
import { deleteBranch, findPullRequestByBranch, getPullRequest, githubConfigured, mergePullRequest, parseRepoUrl, type PullRequest } from "./github.js";

function toApproval(row: typeof schema.approvals.$inferSelect): Approval {
  return {
    id: row.id,
    cardId: row.cardId,
    userId: row.userId,
    prNumber: row.prNumber,
    headSha: row.headSha,
    createdAt: row.createdAt,
    invalidatedAt: row.invalidatedAt,
  };
}

export async function listApprovals(cardId: string): Promise<Approval[]> {
  const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.cardId, cardId));
  return rows.map(toApproval);
}

export class ApprovalError extends Error {
  status = 400;
}

const AGENT: Actor = { kind: "agent", id: null };

async function resolvePullRequest(card: { prNumber: number | null; branch: string | null }, owner: string, repo: string): Promise<PullRequest | null> {
  if (card.prNumber) return getPullRequest(owner, repo, card.prNumber);
  if (card.branch) return findPullRequestByBranch(owner, repo, card.branch);
  return null;
}

// Approval is recorded against the pull request head the Member reviewed, and the merge is
// attempted by the app itself with that SHA as a precondition. See ADR 0006 and ADR 0008.
export async function approveCard(cardId: string, actor: Actor): Promise<Approval> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (card.column !== "review") throw new ApprovalError("Only cards in Review can be approved.");
  if (!actor.id) throw new ApprovalError("Approval needs a signed-in user.");
  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  const approver = await getUser(actor.id);
  const mention = approver ? `@${approver.handle}` : "";

  let pr: PullRequest | null = null;
  if (repo && githubConfigured("merge")) {
    pr = await resolvePullRequest(card, repo.owner, repo.repo);
    if (!pr || pr.state !== "open") throw new ApprovalError("No open pull request is linked to this card yet, so there is nothing to approve.");
    if (pr.number !== card.prNumber || pr.url !== card.prUrl) await setCardWorkState(card.id, { prNumber: pr.number, prUrl: pr.url });
  }

  const id = newId();
  await db.insert(schema.approvals).values({ id, cardId, userId: actor.id, prNumber: pr?.number ?? card.prNumber, headSha: pr?.headSha ?? null });
  await recordEvent({ boardId: card.boardId, cardId, actor, type: "card.approved", payload: { approvalId: id, prNumber: pr?.number ?? card.prNumber, headSha: pr?.headSha ?? null } });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(cardId))! });

  if (!pr || !repo) {
    // No GitHub integration for this board: the Session handles the approval as before.
    await enqueueTrigger({ card, kind: "approval", actorUserId: actor.id, payload: { approvalId: id } });
  } else {
    const outcome = await mergePullRequest(repo.owner, repo.repo, pr.number, pr.headSha, `${pr.title} (#${pr.number})`, pr.body);
    if (outcome.ok) {
      await recordEvent({ boardId: card.boardId, cardId, actor: AGENT, type: "card.merged", payload: { prNumber: pr.number, mergeSha: outcome.sha } });
      await deleteBranch(repo.owner, repo.repo, pr.headRef).catch(() => {});
      // The merge is the end of this card's work: a Session still running on it must not reopen it.
      await closeCardWork(cardId, AGENT);
      const fresh = (await getCard(cardId))!;
      await moveCard(cardId, { column: "done", position: fresh.position, revision: fresh.revision, actor: AGENT });
      await createComment({ cardId, body: `${mention} Merged pull request #${pr.number} and moved this card to Done.`.trim(), actor: AGENT });
    } else if (outcome.reason === "head_changed") {
      await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString() }).where(eq(schema.approvals.id, id));
      await createComment({ cardId, body: `${mention} The branch changed after you approved, so nothing was merged. Please look at the preview again and approve once more if it still looks right.`.trim(), actor: AGENT });
    } else if (outcome.reason === "not_mergeable") {
      // A Session gets the approval trigger so it can rebase. Its push changes the head, which needs a fresh Approval.
      await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString() }).where(eq(schema.approvals.id, id));
      await createComment({ cardId, body: `${mention} Pull request #${pr.number} can't be merged as it stands (${outcome.message}). I'll bring the branch up to date and ask you to approve again.`.trim(), actor: AGENT });
      await enqueueTrigger({ card, kind: "approval", actorUserId: actor.id, payload: { approvalId: id, reason: outcome.message } });
    } else {
      await createComment({ cardId, body: `${mention} GitHub refused the merge: ${outcome.message}. The approval stands; an Admin can retry once the cause is fixed.`.trim(), actor: AGENT });
    }
  }
  const row = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get())!;
  return toApproval(row);
}
