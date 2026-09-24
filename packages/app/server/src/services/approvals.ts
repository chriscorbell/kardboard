import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { Approval, Card } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { recordEvent, type Actor } from "./events.js";
import { closeCardWork, enqueueTrigger } from "./orchestrator.js";
import { publish } from "./realtime.js";
import { getBoardById } from "./boards.js";
import { createComment } from "./comments.js";
import { ConflictError, getCard, moveCard, setCardWorkState } from "./cards.js";
import { getUser } from "./users.js";
import { getAgentProfile } from "./settings.js";
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
  constructor(
    message: string,
    public status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

const AGENT: Actor = { kind: "agent", id: null };

const short = (sha: string) => sha.slice(0, 7);

type Repo = { owner: string; repo: string };

async function resolvePullRequest(card: { prNumber: number | null; branch: string | null }, owner: string, repo: string): Promise<PullRequest | null> {
  if (card.prNumber) return getPullRequest(owner, repo, card.prNumber);
  if (card.branch) return findPullRequestByBranch(owner, repo, card.branch);
  return null;
}

/**
 * Why this pull request cannot stand for this Card, or null when it can. It must come from the
 * branch kardboard gave the Card, in the Board's own repository. The merge App bypasses the branch
 * ruleset, so a Card pointed at any other pull request would have Approval merge work nobody was
 * shown on this Card.
 */
export function pullRequestMismatch(pr: Pick<PullRequest, "number" | "headRef" | "headRepo">, repo: Repo, branch: string | null): string | null {
  const expected = `${repo.owner}/${repo.repo}`;
  if (!pr.headRepo || pr.headRepo.toLowerCase() !== expected.toLowerCase()) return `pull request #${pr.number} comes from ${pr.headRepo ?? "a deleted fork"}, not from ${expected}`;
  if (!branch) return "this card has no branch yet";
  if (pr.headRef !== branch) return `pull request #${pr.number} is for branch ${pr.headRef}, not this card's branch ${branch}`;
  return null;
}

function pullNumberFromUrl(url: string | undefined, repo: Repo): number | null {
  const m = url ? /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url.trim()) : null;
  if (!m || m[1]!.toLowerCase() !== repo.owner.toLowerCase() || m[2]!.toLowerCase() !== repo.repo.toLowerCase()) return null;
  return Number(m[3]);
}

// The head recorded here is the revision the Card shows a Member and the one their Approval has to
// name. A new head voids any Approval still standing on an older one.
async function recordPullRequest(cardId: string, pr: PullRequest): Promise<Card> {
  await db
    .update(schema.approvals)
    .set({ invalidatedAt: new Date().toISOString() })
    .where(and(eq(schema.approvals.cardId, cardId), isNull(schema.approvals.invalidatedAt), or(isNull(schema.approvals.headSha), ne(schema.approvals.headSha, pr.headSha))));
  return setCardWorkState(cardId, { prNumber: pr.number, prUrl: pr.url, prHeadSha: pr.headSha });
}

/**
 * A Session reporting its Card's pull request. With the merge App configured the report is checked
 * on GitHub before it is recorded, and the URL and head come from GitHub rather than from the
 * Session. Without it nothing can merge, so the report is recorded as given.
 */
export async function linkPullRequest(cardId: string, reported: { number?: number; url?: string }): Promise<Card> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  if (!repo || !githubConfigured("merge")) return setCardWorkState(cardId, { prNumber: reported.number, prUrl: reported.url });
  const number = reported.number ?? pullNumberFromUrl(reported.url, repo);
  if (!number) throw new ApprovalError(`pass pr_number, or a pr_url of a pull request in ${repo.owner}/${repo.repo}`);
  const pr = await getPullRequest(repo.owner, repo.repo, number);
  if (!pr) throw new ApprovalError(`pull request #${number} was not found in ${repo.owner}/${repo.repo}`);
  if (pr.state !== "open") throw new ApprovalError(`pull request #${number} is closed; open one from ${card.branch ?? "this card's branch"} and report that`);
  const wrong = pullRequestMismatch(pr, repo, card.branch);
  if (wrong) throw new ApprovalError(`${wrong}. Only the pull request from this card's own branch can be recorded on it.`);
  return recordPullRequest(cardId, pr);
}

/**
 * Called as the Agent moves a Card into Review: the head its pull request has now becomes the one a
 * Member is shown, which covers a push made after the pull request was reported. Returns a note for
 * the Session when the Card's pull request cannot be approved as it stands.
 */
export async function refreshPullRequestHead(cardId: string): Promise<string | null> {
  const card = await getCard(cardId);
  if (!card) return null;
  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  if (!repo || !githubConfigured("merge")) return null;
  const pr = await resolvePullRequest(card, repo.owner, repo.repo);
  if (!pr || pr.state !== "open") return "no open pull request is recorded for this card, so there is nothing a member can approve yet; report it with set_work_state";
  const wrong = pullRequestMismatch(pr, repo, card.branch);
  if (wrong) return `${wrong}, so a member cannot approve it`;
  if (pr.headSha !== card.prHeadSha || pr.number !== card.prNumber || pr.url !== card.prUrl) await recordPullRequest(cardId, pr);
  return null;
}

// Approval is bound to the pull request head the Member was shown: the client sends back the head
// the Card displayed, and nothing merges unless that is still GitHub's head. The app then merges
// with that SHA as GitHub's precondition. See ADR 0006 and ADR 0008.
export async function approveCard(cardId: string, actor: Actor, reviewedSha: string | null): Promise<Approval> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (card.column !== "review") throw new ApprovalError("Only cards in Review can be approved.");
  if (!actor.id) throw new ApprovalError("Approval needs a signed-in user.");
  // A Session still at work can push again, so what the Member looked at is not settled yet.
  if (card.activeSession) throw new ApprovalError(`${(await getAgentProfile()).name} is still working on this card. Approve once the session has finished.`, 409);
  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  const approver = await getUser(actor.id);
  const mention = approver ? `@${approver.handle}` : "";

  let pr: PullRequest | null = null;
  if (repo && githubConfigured("merge")) {
    pr = await resolvePullRequest(card, repo.owner, repo.repo);
    if (!pr || pr.state !== "open") throw new ApprovalError("No open pull request is linked to this card yet, so there is nothing to approve.");
    const wrong = pullRequestMismatch(pr, repo, card.branch);
    if (wrong) throw new ApprovalError(`This card can't be approved: ${wrong}.`);
    if (pr.headSha !== card.prHeadSha || pr.number !== card.prNumber || pr.url !== card.prUrl) await recordPullRequest(card.id, pr);
    // Commits the Member was not shown. The Card now shows the head that is there, so they can look again.
    if (reviewedSha !== pr.headSha) {
      throw new ApprovalError(
        reviewedSha
          ? `The pull request moved on from ${short(reviewedSha)} to ${short(pr.headSha)} since you looked. Check the preview again and approve if it still looks right.`
          : `This card now shows the pull request at ${short(pr.headSha)}. Check it and approve again.`,
        409,
      );
    }
  } else if (card.prHeadSha && reviewedSha !== card.prHeadSha) {
    throw new ApprovalError("This card changed since you loaded it. Look again and approve if it still looks right.", 409);
  }

  const id = newId();
  const headSha = pr?.headSha ?? reviewedSha;
  await db.insert(schema.approvals).values({ id, cardId, userId: actor.id, prNumber: pr?.number ?? card.prNumber, headSha });
  await recordEvent({ boardId: card.boardId, cardId, actor, type: "card.approved", payload: { approvalId: id, prNumber: pr?.number ?? card.prNumber, headSha } });
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
      // GitHub has accepted the merge, so the Card ends in Done whatever moved it in the meantime.
      for (let attempt = 1; ; attempt++) {
        const fresh = (await getCard(cardId))!;
        try {
          await moveCard(cardId, { column: "done", position: fresh.position, revision: fresh.revision, actor: AGENT });
          break;
        } catch (err) {
          if (!(err instanceof ConflictError) || attempt >= 3) throw err;
        }
      }
      await createComment({ cardId, body: `${mention} Merged pull request #${pr.number} and moved this card to Done.`.trim(), actor: AGENT });
    } else if (outcome.reason === "head_changed") {
      await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString() }).where(eq(schema.approvals.id, id));
      await refreshPullRequestHead(cardId).catch((err) => console.error("[approvals] could not re-read the pull request head", err));
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
