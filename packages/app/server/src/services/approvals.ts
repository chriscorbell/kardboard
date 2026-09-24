import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { approvalAwaitingRetry, describeChecks, type Approval, type Card, type ChecksSummary } from "@kardboard/shared";
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
import { deleteBranch, findPullRequestByBranch, getPullRequest, githubConfigured, mergePullRequest, parseRepoUrl, type MergeOutcome, type PullRequest } from "./github.js";
import { refreshCardChecks, toChecksSummary } from "./checks.js";

function toApproval(row: typeof schema.approvals.$inferSelect): Approval {
  return {
    id: row.id,
    cardId: row.cardId,
    userId: row.userId,
    prNumber: row.prNumber,
    headSha: row.headSha,
    createdAt: row.createdAt,
    invalidatedAt: row.invalidatedAt,
    mergeError: row.mergeError,
  };
}

export async function listApprovals(cardId: string): Promise<Approval[]> {
  const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.cardId, cardId)).orderBy(desc(schema.approvals.createdAt));
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

type CardRow = NonNullable<Awaited<ReturnType<typeof getCard>>>;

const cardLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` alone among the things that act on one Card's pull request: Approve, Try merging again,
 * and the reconciliation with GitHub. Without it the poll could read a pull request GitHub merged a
 * moment ago while Approve is still recording that merge, and finish the Card a second time. As
 * with the claim lock, a queue in memory is enough because this process is the database's only
 * writer (ADR 0004), and after a restart nothing is in flight.
 */
export function underCardLock<T>(cardId: string, fn: () => Promise<T>): Promise<T> {
  const run = (cardLocks.get(cardId) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  cardLocks.set(cardId, tail);
  void tail.then(() => {
    if (cardLocks.get(cardId) === tail) cardLocks.delete(cardId);
  });
  return run;
}

/** Whether an Approve, a merge retry, or a reconciliation is under way on this Card right now. */
export function cardLockHeld(cardId: string): boolean {
  return cardLocks.has(cardId);
}

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
// name. A new head voids any Approval still standing on an older one, and checks read for the old
// head no longer describe what the Card shows.
export async function recordPullRequest(cardId: string, pr: PullRequest): Promise<Card> {
  await db
    .update(schema.approvals)
    .set({ invalidatedAt: new Date().toISOString() })
    .where(and(eq(schema.approvals.cardId, cardId), isNull(schema.approvals.invalidatedAt), or(isNull(schema.approvals.headSha), ne(schema.approvals.headSha, pr.headSha))));
  const before = await db.select({ checks: schema.cards.checks }).from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  const stale = Boolean(before?.checks && before.checks.sha !== pr.headSha);
  return setCardWorkState(cardId, { prNumber: pr.number, prUrl: pr.url, prHeadSha: pr.headSha, prBaseRef: pr.baseRef || null, ...(stale ? { checks: null } : {}) });
}

/**
 * recordPullRequest for a caller that read the pull request from GitHub some time ago: it is
 * recorded only if the Card still names `expected` as its head, so an answer that was in flight
 * while a Session reported a newer head cannot put the older one back over it. Returns whether it
 * was recorded.
 */
export async function recordPullRequestIfUnchanged(cardId: string, pr: PullRequest, expected: string | null): Promise<boolean> {
  const before = await db.select({ checks: schema.cards.checks }).from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  const stale = Boolean(before?.checks && before.checks.sha !== pr.headSha);
  const written = await db
    .update(schema.cards)
    .set({ prNumber: pr.number, prUrl: pr.url, prHeadSha: pr.headSha, prBaseRef: pr.baseRef || null, ...(stale ? { checks: null } : {}), updatedAt: new Date().toISOString() })
    .where(and(eq(schema.cards.id, cardId), expected === null ? isNull(schema.cards.prHeadSha) : eq(schema.cards.prHeadSha, expected)))
    .returning({ id: schema.cards.id });
  if (written.length === 0) return false;
  await db
    .update(schema.approvals)
    .set({ invalidatedAt: new Date().toISOString() })
    .where(and(eq(schema.approvals.cardId, cardId), isNull(schema.approvals.invalidatedAt), or(isNull(schema.approvals.headSha), ne(schema.approvals.headSha, pr.headSha))));
  const card = (await getCard(cardId))!;
  publish(card.boardId, { type: "card.upserted", card });
  return true;
}

/** Whether what the Card records of its pull request differs from what GitHub says now. */
function recordedDiffers(card: CardRow, pr: PullRequest): boolean {
  return pr.headSha !== card.prHeadSha || pr.number !== card.prNumber || pr.url !== card.prUrl || (pr.baseRef || null) !== card.prBaseRef;
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
  if (recordedDiffers(card, pr)) await recordPullRequest(cardId, pr);
  return null;
}

/**
 * What a merge attempt means for the Approval it was made on: whether the Approval survives, what
 * the Card is told, and whether a Session is asked to bring the branch up to date. A refusal
 * GitHub gave for some other reason — a required check, a protected path, a rate limit — leaves
 * the Approval standing, because the Member's sign-off is still good for that head.
 */
export type MergeFollowUp =
  | { kind: "merged"; sha: string }
  | { kind: "invalidated"; comment: string; rerun: false }
  | { kind: "invalidated"; comment: string; rerun: true; reason: string }
  | { kind: "refused"; comment: string; error: string };

export function followUpFor(outcome: MergeOutcome, prNumber: number, mention: string): MergeFollowUp {
  if (outcome.ok) return { kind: "merged", sha: outcome.sha };
  if (outcome.reason === "head_changed") {
    return { kind: "invalidated", rerun: false, comment: `${mention} The branch changed after you approved, so nothing was merged. Please look at the change again and approve once more if it still looks right.`.trim() };
  }
  if (outcome.reason === "not_mergeable") {
    // A Session gets the approval trigger so it can rebase. Its push changes the head, which needs a fresh Approval.
    return {
      kind: "invalidated",
      rerun: true,
      reason: outcome.message,
      comment: `${mention} Pull request #${prNumber} can't be merged as it stands (${outcome.message}). I'll bring the branch up to date and ask you to approve again.`.trim(),
    };
  }
  if (outcome.reason === "closed") {
    // Someone closed it on GitHub. The Approval was for that pull request as it stood, and the poll
    // moves the Card to Blocked and asks what should happen next.
    return { kind: "invalidated", rerun: false, comment: `${mention} Pull request #${prNumber} was closed on GitHub before it could merge, so nothing was merged.`.trim() };
  }
  if (outcome.reason === "pending") {
    // GitHub had not finished working out whether it can merge, even when asked again. Nothing is
    // wrong with the pull request, so nothing is voided and nobody is sent to change the branch.
    return {
      kind: "refused",
      error: "GitHub was still checking whether this pull request can be merged.",
      comment: `${mention} GitHub was still checking whether pull request #${prNumber} can be merged, so nothing was merged yet. Your approval still stands: press Try merging again on this card in a minute.`.trim(),
    };
  }
  return { kind: "refused", error: outcome.message, comment: `${mention} GitHub refused the merge: ${outcome.message}. Your approval still stands: press Try merging again on this card once the cause is fixed.`.trim() };
}

// Merge on a recorded Approval, sending the head the Member reviewed as GitHub's precondition, and
// carry out whatever the outcome means for the Card. Shared by the Approve control and Try merging
// again. A merge call that throws, GitHub unreachable or a token that could not be minted, is a
// refusal the Approval survives: left to propagate it would leave an Approval standing with nothing
// on the Card to say why nothing merged.
async function mergeOnApproval(input: { card: CardRow; approvalId: string; pr: PullRequest; headSha: string; repo: Repo; mention: string; actorUserId: string }): Promise<void> {
  const { card, approvalId, pr, repo, mention } = input;
  const outcome: MergeOutcome = await mergePullRequest(repo.owner, repo.repo, pr.number, input.headSha, `${pr.title} (#${pr.number})`, pr.body).catch((err: Error) => ({
    ok: false as const,
    reason: "error" as const,
    message: `the merge call failed (${err.message})`,
  }));
  const followUp = followUpFor(outcome, pr.number, mention);

  if (followUp.kind === "merged") {
    await db.update(schema.approvals).set({ mergeError: null }).where(eq(schema.approvals.id, approvalId));
    await completeMerge(card, { prNumber: pr.number, headRef: pr.headRef, mergeSha: followUp.sha, repo, actor: AGENT, comment: `${mention} Merged pull request #${pr.number} and moved this card to Done.`.trim() });
    return;
  }

  if (followUp.kind === "invalidated") {
    await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString(), mergeError: null }).where(eq(schema.approvals.id, approvalId));
    if (!followUp.rerun) await refreshPullRequestHead(card.id).catch((err) => console.error("[approvals] could not re-read the pull request head", err));
    await createComment({ cardId: card.id, body: followUp.comment, actor: AGENT });
    if (followUp.rerun) await enqueueTrigger({ card, kind: "approval", actorUserId: input.actorUserId, payload: { approvalId, reason: followUp.reason } });
    return;
  }

  await db.update(schema.approvals).set({ mergeError: followUp.error }).where(eq(schema.approvals.id, approvalId));
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: AGENT, type: "card.merge_refused", payload: { prNumber: pr.number, error: followUp.error } });
  await createComment({ cardId: card.id, body: followUp.comment, actor: AGENT });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(card.id))! });
}

/**
 * The end of a Card whose pull request GitHub has merged, whether kardboard merged it on an
 * Approval or someone merged it on GitHub. The recorded `card.merged` is what makes the Card's
 * outcome `implemented`, so it is written first and only once; then the branch goes, a Session
 * still at work is ended and the Preview torn down, and the Card lands in Done whatever moved it
 * meanwhile. Safe to run again on a Card a restart left half way through.
 */
export async function completeMerge(card: CardRow, input: { prNumber: number; headRef: string; mergeSha: string | null; repo: Repo; actor: Actor; comment: string; onGitHub?: boolean }): Promise<void> {
  const merges = await db.select({ payload: schema.events.payload }).from(schema.events).where(and(eq(schema.events.cardId, card.id), eq(schema.events.type, "card.merged")));
  if (!merges.some((e) => e.payload.prNumber === input.prNumber)) {
    await recordEvent({ boardId: card.boardId, cardId: card.id, actor: input.actor, type: "card.merged", payload: { prNumber: input.prNumber, mergeSha: input.mergeSha, ...(input.onGitHub ? { onGitHub: true } : {}) } });
  }
  await deleteBranch(input.repo.owner, input.repo.repo, input.headRef).catch(() => {});
  // The merge is the end of this card's work: a Session still running on it must not reopen it.
  await closeCardWork(card.id, AGENT);
  // GitHub has accepted the merge, so the Card ends in Done whatever moved it in the meantime.
  for (let attempt = 1; ; attempt++) {
    const fresh = (await getCard(card.id))!;
    if (fresh.column === "done") break;
    try {
      await moveCard(card.id, { column: "done", position: fresh.position, revision: fresh.revision, actor: AGENT });
      break;
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt >= 3) throw err;
    }
  }
  await createComment({ cardId: card.id, body: input.comment, actor: AGENT });
}

/**
 * The checks gate on a merge. CI is read again for the head about to merge rather than taken from
 * what the Card last showed, and a failing run refuses the merge unless the Admin chose to merge
 * anyway. Pending and unknown do not refuse: the Member was warned of the first before approving,
 * and the second is a repository that does not let kardboard see its checks at all.
 */
async function checksGate(card: CardRow, repo: Repo, pr: PullRequest, headSha: string, overrideChecks: boolean): Promise<ChecksSummary> {
  const summary = toChecksSummary(await refreshCardChecks(card.id, repo, headSha), headSha);
  if (summary.state === "failing" && !overrideChecks) {
    throw new ApprovalError(`${describeChecks(summary)} on pull request #${pr.number}, so it can't be merged yet. Once they pass it can be; the Admin can also merge it anyway.`, 409);
  }
  return summary;
}

/**
 * Why Approve or a merge retry has to wait for the Agent, or null when it need not. A Session still
 * at work can push again, so what the Member looked at is not settled yet. Nor is it while a Trigger
 * waits to start one — a comment asking for a change, an edit, a move, held by the batching window,
 * a paused Board, or full slots — since that Session may push too, and a merge now would close the
 * Card and drop the request unanswered.
 */
async function agentHold(cardId: string, then: string): Promise<string | null> {
  const card = await getCard(cardId);
  if (!card) return null;
  const agent = (await getAgentProfile()).name;
  if (card.activeSession) return `${agent} is still working on this card. ${then} once the session has finished.`;
  const pending = await db
    .select({ kind: schema.triggers.kind })
    .from(schema.triggers)
    .where(and(eq(schema.triggers.cardId, cardId), eq(schema.triggers.status, "pending")));
  if (pending.length === 0) return null;
  const kinds = new Set(pending.map((t) => t.kind));
  if (kinds.has("comment_posted") || kinds.has("comment_edited")) return `${agent} hasn't read the latest comment yet. ${then} once it has.`;
  if (kinds.has("card_edited")) return `${agent} hasn't read the latest edit to this card yet. ${then} once it has.`;
  if (kinds.has("card_moved") || kinds.has("card_created")) return `${agent} hasn't picked up the latest change to this card yet. ${then} once it has.`;
  return `${agent} is about to pick this card up again. ${then} once that session has finished.`;
}

// Approval is bound to the pull request head the Member was shown: the client sends back the head
// the Card displayed, and nothing merges unless that is still GitHub's head. The app then merges
// with that SHA as GitHub's precondition. See ADR 0006 and ADR 0008. `overrideChecks` is the
// Admin's alone; the route drops it for anyone else.
export function approveCard(cardId: string, actor: Actor, reviewedSha: string | null, options: { overrideChecks?: boolean } = {}): Promise<Approval> {
  return underCardLock(cardId, () => approveUnderLock(cardId, actor, reviewedSha, options.overrideChecks === true));
}

async function approveUnderLock(cardId: string, actor: Actor, reviewedSha: string | null, overrideChecks: boolean): Promise<Approval> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (card.column !== "review") throw new ApprovalError("Only cards in Review can be approved.");
  if (!actor.id) throw new ApprovalError("Approval needs a signed-in user.");
  const hold = await agentHold(cardId, "Approve");
  if (hold) throw new ApprovalError(hold, 409);
  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  const mention = await mentionFor(actor.id);

  let pr: PullRequest | null = null;
  let checks: ChecksSummary | null = null;
  if (repo && githubConfigured("merge")) {
    pr = await resolvePullRequest(card, repo.owner, repo.repo);
    if (!pr || pr.state !== "open") throw new ApprovalError("No open pull request is linked to this card yet, so there is nothing to approve.");
    const wrong = pullRequestMismatch(pr, repo, card.branch);
    if (wrong) throw new ApprovalError(`This card can't be approved: ${wrong}.`);
    if (recordedDiffers(card, pr)) await recordPullRequest(card.id, pr);
    // Commits the Member was not shown. The Card now shows the head that is there, so they can look again.
    if (reviewedSha !== pr.headSha) {
      throw new ApprovalError(
        reviewedSha
          ? `The pull request moved on from ${short(reviewedSha)} to ${short(pr.headSha)} since you looked. Check it again and approve if it still looks right.`
          : `This card now shows the pull request at ${short(pr.headSha)}. Check it and approve again.`,
        409,
      );
    }
    checks = await checksGate(card, repo, pr, pr.headSha, overrideChecks);
  } else if (card.prHeadSha && reviewedSha !== card.prHeadSha) {
    throw new ApprovalError("This card changed since you loaded it. Look again and approve if it still looks right.", 409);
  }
  // Reading GitHub takes a moment, and a comment or a Session can arrive in it.
  const late = await agentHold(cardId, "Approve");
  if (late) throw new ApprovalError(late, 409);

  const id = newId();
  const headSha = pr?.headSha ?? reviewedSha;
  await db.insert(schema.approvals).values({ id, cardId, userId: actor.id, prNumber: pr?.number ?? card.prNumber, headSha });
  await recordEvent({
    boardId: card.boardId,
    cardId,
    actor,
    type: "card.approved",
    payload: { approvalId: id, prNumber: pr?.number ?? card.prNumber, headSha, ...(checks ? { checks: checks.state } : {}), ...(checks?.state === "failing" ? { overrideChecks: true } : {}) },
  });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(cardId))! });

  if (!pr || !repo) {
    // No GitHub integration for this board: the Session handles the approval as before.
    await enqueueTrigger({ card, kind: "approval", actorUserId: actor.id, payload: { approvalId: id } });
  } else {
    await mergeOnApproval({ card, approvalId: id, pr, headSha: pr.headSha, repo, mention, actorUserId: actor.id });
  }
  return (await readApproval(id))!;
}

/**
 * Try the merge again on an Approval GitHub refused for a reason that left it standing. The head
 * the Member reviewed is still the precondition, so a push in the meantime fails the retry and
 * asks for a fresh Approval rather than merging something nobody saw. Checks are gated as on
 * Approve, with the same Admin override.
 */
export function retryMerge(cardId: string, actor: Actor, options: { overrideChecks?: boolean } = {}): Promise<Approval> {
  return underCardLock(cardId, () => retryUnderLock(cardId, actor, options.overrideChecks === true));
}

async function retryUnderLock(cardId: string, actor: Actor, overrideChecks: boolean): Promise<Approval> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (!actor.id) throw new ApprovalError("Retrying a merge needs a signed-in user.");
  if (card.column !== "review") throw new ApprovalError("Only cards in Review can be merged.");
  const hold = await agentHold(cardId, "Try the merge again");
  if (hold) throw new ApprovalError(hold, 409);

  const approval = approvalAwaitingRetry(await listApprovals(cardId));
  if (!approval) throw new ApprovalError("No approval on this card is waiting on a refused merge.");

  const board = (await getBoardById(card.boardId))!;
  const repo = parseRepoUrl(board.repoUrl);
  if (!repo || !githubConfigured("merge")) throw new ApprovalError("This board has no GitHub merge app configured, so kardboard cannot merge for you.");

  const pr = await resolvePullRequest(card, repo.owner, repo.repo);
  if (!pr || pr.state !== "open") throw new ApprovalError("No open pull request is linked to this card, so there is nothing to merge.");
  const wrong = pullRequestMismatch(pr, repo, card.branch);
  if (wrong) throw new ApprovalError(`This card can't be merged: ${wrong}.`);
  if (!approval.headSha || (approval.prNumber && pr.number !== approval.prNumber)) {
    await db.update(schema.approvals).set({ invalidatedAt: new Date().toISOString(), mergeError: null }).where(eq(schema.approvals.id, approval.id));
    publish(card.boardId, { type: "card.upserted", card: (await getCard(cardId))! });
    throw new ApprovalError(`The approval was not given for pull request #${pr.number} as it stands. Please review it and approve again.`, 409);
  }
  // A head that moved fails the merge's own precondition below, which voids the Approval and asks
  // for a fresh look; the checks of a commit nobody approved have nothing to say about that.
  const checks = pr.headSha === approval.headSha ? await checksGate(card, repo, pr, approval.headSha, overrideChecks) : null;
  const late = await agentHold(cardId, "Try the merge again");
  if (late) throw new ApprovalError(late, 409);

  const mention = await mentionFor(actor.id);
  await recordEvent({
    boardId: card.boardId,
    cardId,
    actor,
    type: "card.merge_retried",
    payload: { approvalId: approval.id, prNumber: pr.number, ...(checks ? { checks: checks.state } : {}), ...(checks?.state === "failing" ? { overrideChecks: true } : {}) },
  });
  await mergeOnApproval({ card, approvalId: approval.id, pr, headSha: approval.headSha, repo, mention, actorUserId: actor.id });
  return (await readApproval(approval.id))!;
}

async function mentionFor(userId: string): Promise<string> {
  const user = await getUser(userId);
  return user ? `@${user.handle}` : "";
}

async function readApproval(id: string): Promise<Approval | null> {
  const row = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  return row ? toApproval(row) : null;
}
