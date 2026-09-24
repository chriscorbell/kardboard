import { eq } from "drizzle-orm";
import type { ChecksSummary } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { publish } from "./realtime.js";
import { getCard } from "./cards.js";
import { readCommitChecks, type CommitChecks } from "./github.js";

// A Card's CI, as kardboard last read it for the pull request head the Card shows. The summary is
// stored on the Card so the board can show it without asking GitHub; the reconciliation poll, the
// Approve control, and a Member opening the Card in Review each read it again.

type Repo = { owner: string; repo: string };

export function toChecksSummary(read: Pick<CommitChecks, "state" | "total" | "failed" | "pending">, sha: string, at = new Date()): ChecksSummary {
  return { state: read.state, total: read.total, failed: read.failed, pending: read.pending, sha, updatedAt: at.toISOString() };
}

/**
 * Reads CI for `sha` and stores it on the Card, as long as that is still the head the Card shows:
 * a slow read must not put an older commit's checks over a newer one's. Nor does a read GitHub
 * failed to answer replace what the Card last knew with `unknown`, which would say the repository
 * hides its checks when it only had a bad moment. The Card is published only when the summary
 * changed, since the poll reads it every couple of minutes.
 */
export async function refreshCardChecks(cardId: string, repo: Repo, sha: string): Promise<CommitChecks> {
  const read = await readCommitChecks(repo.owner, repo.repo, sha);
  if (read.unavailable) return read;
  const row = await db.select({ prHeadSha: schema.cards.prHeadSha, checks: schema.cards.checks }).from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  if (!row || row.prHeadSha !== sha) return read;
  const summary = toChecksSummary(read, sha);
  await db.update(schema.cards).set({ checks: summary }).where(eq(schema.cards.id, cardId));
  const before = row.checks;
  const changed = !before || before.sha !== sha || before.state !== summary.state || before.total !== summary.total || before.failed !== summary.failed || before.pending !== summary.pending;
  if (changed) {
    const card = await getCard(cardId);
    if (card) publish(card.boardId, { type: "card.upserted", card });
  }
  return read;
}
