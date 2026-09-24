import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { recordEvent, SYSTEM_ACTOR, type Actor } from "./events.js";
import { publish } from "./realtime.js";
import { getBoardById } from "./boards.js";
import { createComment } from "./comments.js";
import { ConflictError, forgetMergedPullRequest, getCard, mergeRecordedAt, moveCard } from "./cards.js";
import { getUser } from "./users.js";
import { getPullRequest, githubConfigured, parseRepoUrl, type PullRequest } from "./github.js";
import { cardLockHeld, completeMerge, listApprovals, pullRequestMismatch, recordPullRequestIfUnchanged, underCardLock } from "./approvals.js";
import { refreshCardChecks } from "./checks.js";
import { underClaimLock } from "./orchestrator.js";

// Both GitHub Apps run with webhooks off, so kardboard learns what happened to a pull request only
// by asking. This poll asks about every Card that has one and is not in Done, every couple of
// minutes and once shortly after boot, and settles what it finds:
//
//   merged      The Card is completed exactly as kardboard's own merge completes it, outcome
//               `implemented` included. This is also how a restart between GitHub accepting a
//               merge and the Card reaching Done is finished (design review, finding 4). A Card
//               that did reach Done on that merge and was reopened since is not completed again.
//   closed      Closed without a merge: the Card goes to Blocked and its creator is asked what now.
//   new head    Someone pushed to the branch. The Card shows the new head, Approvals of the old one
//               are void, and a Card in Review says it needs another look.
//   interrupted An Approval still standing with no merge and no refusal is a merge that did not
//               finish: most often one a restart cut short, but also an Approval older than refusals
//               being recorded, or one a Session was to merge. It gets a refusal and the Try merging
//               again control.
//
// Nothing here is a Trigger. A Session holding the Claim pushes its own branch and reports its own
// pull request, so while one does the poll only records the new head and leaves the rest to it.
// GitHub takes a moment to answer, and a Session can start or report a newer head in it, so the
// Card is read again once GitHub has answered and a head is recorded only over the one it replaces.

const AGENT: Actor = { kind: "agent", id: null };

const POLL_MS = 2 * 60_000;
const BOOT_DELAY_MS = 10_000;
// A Member opening a Card asks GitHub at most this often per Card, however many of them look.
const ON_DEMAND_MS = 30_000;

export type ReconcileResult = "skipped" | "busy" | "unchanged" | "merged" | "closed" | "head_changed";

const short = (sha: string) => sha.slice(0, 7);

/** Settles one Card against its pull request on GitHub. Skips a Card an Approve or retry is working on. */
export async function reconcileCard(cardId: string): Promise<ReconcileResult> {
  if (cardLockHeld(cardId)) return "busy";
  return underCardLock(cardId, () => reconcileUnderLock(cardId));
}

async function reconcileUnderLock(cardId: string): Promise<ReconcileResult> {
  const asked = await getCard(cardId);
  if (!asked || asked.column === "done" || !asked.prNumber) return "skipped";
  const board = await getBoardById(asked.boardId);
  const repo = parseRepoUrl(board?.repoUrl ?? null);
  if (!repo || !githubConfigured("merge")) return "skipped";
  const pr = await getPullRequest(repo.owner, repo.repo, asked.prNumber);
  // Decided from the Card as it stands now: a Session may have started, or reported, meanwhile.
  const card = await getCard(cardId);
  if (!card || card.column === "done" || card.prNumber !== asked.prNumber) return "skipped";
  // Only the Card's own pull request speaks for it: see pullRequestMismatch.
  if (!pr || pullRequestMismatch(pr, repo, card.branch)) return "skipped";

  if (pr.merged) {
    const mergedAt = await mergeRecordedAt(card.id, pr.number);
    const byKardboard = mergedAt !== null;
    // This merge was completed and the Card has been reopened since: it is new work, and the
    // Session doing it must not be ended nor its branch deleted. Cards reopened before moveCard
    // forgot a merged pull request still name it, so it is forgotten here instead.
    if (mergedAt && (await leftDoneSince(card.id, mergedAt))) {
      await forgetMergedPullRequest(card.id, pr.number);
      return "skipped";
    }
    // Merged on GitHub while the Card sat in Done, which the poll does not look at, and reopened
    // since: the same new work, whose branch and Session must be left alone.
    if (!mergedAt && pr.closedAt && (await leftDoneSince(card.id, pr.closedAt))) {
      await forgetMergedPullRequest(card.id, pr.number);
      return "skipped";
    }
    await completeMerge(card, {
      prNumber: pr.number,
      headRef: pr.headRef,
      mergeSha: pr.mergeCommitSha,
      repo,
      actor: SYSTEM_ACTOR,
      onGitHub: !byKardboard,
      mergedAt: pr.closedAt,
      comment: byKardboard ? `Merged pull request #${pr.number} and moved this card to Done.` : `Pull request #${pr.number} was merged on GitHub, so this card is Done.`,
    });
    return "merged";
  }
  if (pr.state === "closed") return closedWithoutMerge(card, pr);

  // GitHub's answer is recorded only over the head the Card showed when it was asked: a head a
  // Session reported while it answered is newer than the answer.
  let result: ReconcileResult = "unchanged";
  if (pr.headSha !== card.prHeadSha) result = await headMoved(card, pr, asked.prHeadSha);
  else if ((pr.baseRef || null) !== card.prBaseRef) await recordPullRequestIfUnchanged(card.id, pr, asked.prHeadSha);
  await flagInterruptedMerge(cardId, pr);
  if (card.column === "review") await refreshCardChecks(card.id, repo, pr.headSha);
  return result;
}

type CardView = NonNullable<Awaited<ReturnType<typeof getCard>>>;

/** Whether the Card left Done at or after `since`. */
async function leftDoneSince(cardId: string, since: string): Promise<boolean> {
  const moves = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.cardId, cardId), eq(schema.events.type, "card.moved"), gte(schema.events.createdAt, since)));
  return moves.some((e) => e.payload.from === "done");
}

async function headMoved(card: CardView, pr: PullRequest, from: string | null): Promise<ReconcileResult> {
  const voided = (await listApprovals(card.id)).filter((a) => !a.invalidatedAt && a.headSha !== pr.headSha);
  if (!(await recordPullRequestIfUnchanged(card.id, pr, from))) return "unchanged";
  // A Session pushing its own branch is the ordinary way a head moves, and it reports that itself.
  // Outside Review nobody is being asked to approve anything, and with no head recorded before
  // there is nothing a Member saw that the new one differs from.
  if (card.activeSession || card.column !== "review" || !from) return "unchanged";
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: SYSTEM_ACTOR, type: "pull_request.head_changed", payload: { prNumber: pr.number, from, to: pr.headSha } });
  const approvers = await handles(voided.map((a) => a.userId));
  const mention = approvers.length ? `${approvers.join(" ")} ` : "";
  await createComment({
    cardId: card.id,
    actor: AGENT,
    body: `${mention}New commits were pushed to pull request #${pr.number}, which now stands at ${short(pr.headSha)}. Please look again before approving${voided.length ? "; the earlier approval no longer applies" : ""}.`,
  });
  return "head_changed";
}

async function closedWithoutMerge(card: CardView, pr: PullRequest): Promise<ReconcileResult> {
  // A Session may be closing this pull request to open another; it reports what it opens.
  if (card.activeSession) return "unchanged";
  // Once per closing: the poll sees the same closed pull request every time it runs, but a
  // pull request reopened and closed again has a new closing time.
  const seen = await db.select({ payload: schema.events.payload }).from(schema.events).where(and(eq(schema.events.cardId, card.id), eq(schema.events.type, "pull_request.closed")));
  if (seen.some((e) => e.payload.prNumber === pr.number && e.payload.closedAt === pr.closedAt)) return "unchanged";
  // Looked at and moved under the claim lock, so no Session can start between the two: one that
  // started a moment ago is left to report what it opens, as above, and one someone closed is done.
  const blocked = await underClaimLock(async () => {
    for (let attempt = 1; ; attempt++) {
      const fresh = await getCard(card.id);
      if (!fresh || fresh.activeSession || fresh.column === "done" || fresh.prNumber !== pr.number) return false;
      if (fresh.column === "blocked") return true;
      try {
        await moveCard(card.id, { column: "blocked", position: fresh.position, revision: fresh.revision, actor: AGENT });
        return true;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= 3) throw err;
      }
    }
  });
  if (!blocked) return "unchanged";
  await recordEvent({ boardId: card.boardId, cardId: card.id, actor: SYSTEM_ACTOR, type: "pull_request.closed", payload: { prNumber: pr.number, closedAt: pr.closedAt } });
  const creator = card.creatorKind === "user" && card.creatorId ? await handles([card.creatorId]) : [];
  await createComment({
    cardId: card.id,
    actor: AGENT,
    body: `${creator.length ? `${creator[0]} ` : ""}Pull request #${pr.number} was closed on GitHub without being merged, so I've moved this card to Blocked. Should the work go on in a new pull request, or should this card be closed?`,
  });
  return "closed";
}

/**
 * Approve merges before it returns, so an Approval that is still standing with neither a merge nor
 * a refusal on record, looked at under the Card's lock, is a merge that did not finish. Usually a
 * restart cut it short, but an Approval from before refusals were recorded, or one a Session was to
 * merge, looks the same, so what the Card is told holds for all of them. It gets the refusal a
 * failed merge call would have given it, which puts Try merging again on the Card.
 */
async function flagInterruptedMerge(cardId: string, pr: PullRequest): Promise<void> {
  const card = await getCard(cardId);
  if (!card || card.column !== "review" || card.activeSession) return;
  const stranded = (await listApprovals(cardId)).filter((a) => !a.invalidatedAt && !a.mergeError && a.headSha === pr.headSha);
  if (stranded.length === 0) return;
  const error = "The merge on this approval did not finish, and nothing was merged.";
  for (const a of stranded) await db.update(schema.approvals).set({ mergeError: error }).where(eq(schema.approvals.id, a.id));
  await recordEvent({ boardId: card.boardId, cardId, actor: SYSTEM_ACTOR, type: "card.merge_refused", payload: { prNumber: pr.number, error } });
  const approvers = await handles(stranded.map((a) => a.userId));
  await createComment({
    cardId,
    actor: AGENT,
    body: `${approvers.length ? `${approvers.join(" ")} ` : ""}The merge of pull request #${pr.number} on this approval did not finish, and nothing was merged. The approval still stands: press Try merging again on this card.`,
  });
  publish(card.boardId, { type: "card.upserted", card: (await getCard(cardId))! });
}

async function handles(userIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(userIds)) {
    const user = await getUser(id);
    if (user) out.push(`@${user.handle}`);
  }
  return out;
}

let polling = false;

/** One pass over every Card with a pull request that is not in Done. Never throws. */
export async function reconcilePullRequests(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const rows = await db
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(and(isNotNull(schema.cards.prNumber), ne(schema.cards.column, "done")));
    for (const { id } of rows) {
      try {
        await reconcileCard(id);
      } catch (err) {
        console.error(`[reconcile] could not settle card ${id} with GitHub: ${(err as Error).message}`);
      }
    }
    const stale = Date.now() - ON_DEMAND_MS;
    for (const [id, at] of lastAsked) if (at < stale) lastAsked.delete(id);
  } catch (err) {
    console.error("[reconcile] poll failed", err);
  } finally {
    polling = false;
  }
}

const lastAsked = new Map<string, number>();

/**
 * A Member opened the Card in Review, so what it shows of its pull request and CI is read again
 * now, unless that was done for this Card in the last half minute.
 */
export async function reconcileOnDemand(cardId: string): Promise<ReconcileResult | "recent"> {
  if (Date.now() - (lastAsked.get(cardId) ?? 0) < ON_DEMAND_MS) return "recent";
  lastAsked.set(cardId, Date.now());
  return reconcileCard(cardId);
}

let timers: NodeJS.Timeout[] = [];

// Unref'd like the orchestrator's timers: a poll never holds the process open, and one that did not
// run before a restart runs again after it.
export function startPullRequestReconciler(): void {
  stopPullRequestReconciler();
  const tick = () => void reconcilePullRequests();
  const boot = setTimeout(tick, BOOT_DELAY_MS);
  const every = setInterval(tick, POLL_MS);
  boot.unref();
  every.unref();
  timers = [boot, every];
}

export function stopPullRequestReconciler(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
