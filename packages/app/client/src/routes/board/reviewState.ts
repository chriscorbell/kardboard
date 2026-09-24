import { approvalAwaitingRetry, describeChecks, type Approval, type Card, type CheckState, type ChecksSummary } from "@kardboard/shared";

// The decisions behind the Review block, kept out of the component so they can be tested without a
// DOM: which state the block is in, what the checks allow, and what Approve and Close say they do.

/** Runner Previews carry a status on the Card; until that field exists everywhere it may be absent. */
type PreviewState = { preview?: { status: "building" | "running" | "failed" } | null };

export type ReviewStage =
  /** GitHub refused the merge for a reason the Approval survives: offer to try again. */
  | { kind: "refused"; approval: Approval }
  /** Approved and not refused: the merge is under way, or a Session will carry it out. */
  | { kind: "approved"; approval: Approval }
  | { kind: "working" }
  /** A comment, edit or move is still waiting for a Session, which may change the pull request. */
  | { kind: "waiting" }
  /** Nothing recorded to merge, so nothing to approve. */
  | { kind: "no_pr" }
  | { kind: "ready" };

export function reviewStage(card: Pick<Card, "activeSession" | "waiting" | "prNumber" | "prUrl">, approvals: Approval[]): ReviewStage {
  const refused = approvalAwaitingRetry(approvals);
  if (refused) return { kind: "refused", approval: refused };
  const live = approvals.find((a) => !a.invalidatedAt);
  if (live) return { kind: "approved", approval: live };
  if (card.activeSession) return { kind: "working" };
  if (card.waiting) return { kind: "waiting" };
  if (!card.prNumber && !card.prUrl) return { kind: "no_pr" };
  return { kind: "ready" };
}

/**
 * Why Try merging again is held back, as the server holds it: a Session at work, or one still to
 * start on a comment or change nobody has answered. Null when nothing holds it.
 */
export function retryHold(card: Pick<Card, "activeSession" | "waiting">, agentName: string): string | null {
  if (card.activeSession) return `${agentName} is working on this card. You can try again once the session has finished.`;
  if (card.waiting) return `${agentName} hasn't read the latest comment or change yet. You can try again once it has.`;
  return null;
}

// ---- the head the Member is reviewing ----

/**
 * The pull request head a Member is looking at, which is what Approve sends. The poll and the sync
 * rewrite the Card's head whenever GitHub's moves, so the head at the moment of the click may be
 * one the Member never saw. The pin follows the Card until the block's first read from GitHub has
 * settled, and while it has shown no head at all; after that a new head is taken up only when the
 * Member asks to look at it.
 */
export interface ReviewPin {
  cardId: string;
  sha: string | null;
  settled: boolean;
}

/** The pin as of this render. The same object back when nothing changed, so it can be kept in state. */
export function followPin(pin: ReviewPin | null, card: Pick<Card, "id" | "prHeadSha">, readSettled: boolean): ReviewPin {
  if (pin && pin.cardId === card.id && pin.settled && pin.sha !== null) return pin;
  if (pin && pin.cardId === card.id && pin.sha === card.prHeadSha && pin.settled === readSettled) return pin;
  return { cardId: card.id, sha: card.prHeadSha, settled: readSettled };
}

/** The Member chose to look at the head the Card shows now. */
export function repin(card: Pick<Card, "id" | "prHeadSha">): ReviewPin {
  return { cardId: card.id, sha: card.prHeadSha, settled: true };
}

export interface HeadMove {
  from: string;
  to: string;
}

/** How the pull request moved on from the head the Member is looking at, or null if it has not. */
export function headMove(pin: ReviewPin, card: Pick<Card, "id" | "prHeadSha">): HeadMove | null {
  if (pin.cardId !== card.id || !pin.settled || !pin.sha || !card.prHeadSha || pin.sha === card.prHeadSha) return null;
  return { from: pin.sha, to: card.prHeadSha };
}

/** GitHub's page of what changed from one head to the other. */
export function compareUrl(prUrl: string | null, move: HeadMove): string | null {
  const repo = prUrl ? /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl.trim()) : null;
  return repo ? `${repo[1]}/compare/${move.from}...${move.to}` : null;
}

/**
 * Whether Approve or a retry was just refused because GitHub did not answer about the checks. The
 * server says so with a `reason` beside its sentence, which the request error carries as `data`.
 */
export function checksUnreadable(error: unknown): boolean {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : undefined;
  return Boolean(data && typeof data === "object" && (data as { reason?: unknown }).reason === "checks_unavailable");
}

/** Said before the Admin merges without the checks GitHub did not show. */
export const SKIP_CHECKS_WARNING = "GitHub didn't say how the checks went, so this merges without them.";

/** The checks worth showing: those read for the head the Card shows, not an older one. */
export function currentChecks(card: Pick<Card, "checks" | "prHeadSha">): ChecksSummary | null {
  return card.checks && card.prHeadSha && card.checks.sha === card.prHeadSha ? card.checks : null;
}

export const CHECK_TONES: Record<CheckState, "ok" | "danger" | "warn" | "muted"> = {
  passing: "ok",
  failing: "danger",
  pending: "warn",
  none: "muted",
  unknown: "muted",
};

/**
 * Whether the checks line is shown at all. `unknown` usually means the Merge app was not granted
 * the Checks or Commit statuses permission, which only the Admin can do anything about.
 */
export function showChecks(checks: ChecksSummary | null, isAdmin: boolean): checks is ChecksSummary {
  return Boolean(checks) && (checks!.state !== "unknown" || isAdmin);
}

/** GitHub's page listing a pull request's checks. */
export function checksPageUrl(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const base = prUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(base) ? `${base}/checks` : prUrl;
}

export interface ApproveGate {
  /** Approve cannot be used: a Member facing failing checks. */
  blocked: boolean;
  /** Approving means the Admin merging over failing checks. */
  override: boolean;
  /** Said under the block when Approve is held back. */
  reason: string | null;
  /** Said in the confirmation before anything merges. */
  warning: string | null;
}

/**
 * What the checks let Approve do. The server holds the same line for failing checks and lets the
 * Admin alone override it; running checks only earn a warning, since some CI takes longer than
 * anyone should have to wait to approve a change they have already tried.
 */
export function approveGate(checks: ChecksSummary | null, isAdmin: boolean): ApproveGate {
  if (checks?.state === "failing") {
    return isAdmin
      ? { blocked: false, override: true, reason: null, warning: `${describeChecks(checks)}. As the Admin you can merge it anyway.` }
      : { blocked: true, override: false, reason: "The checks have to pass before this can be merged.", warning: null };
  }
  if (checks?.state === "pending") return { blocked: false, override: false, reason: null, warning: `${describeChecks(checks)}. Approving now merges without waiting for them.` };
  return { blocked: false, override: false, reason: null, warning: null };
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The confirmation's plain statement of what Approve does. */
export function mergeStatement(card: Pick<Card, "prNumber" | "prHeadSha" | "prBaseRef">): string {
  const pr = card.prNumber ? `pull request #${card.prNumber}` : "the pull request";
  const at = card.prHeadSha ? ` at ${shortSha(card.prHeadSha)}` : "";
  const into = card.prBaseRef ? `into ${card.prBaseRef}` : "into its base branch";
  return `This merges ${pr}${at} ${into} and moves the card to Done. The project's deploy runs from there.`;
}

/** The confirmation's statement of what Close does. */
export function closeStatement(card: Pick<Card, "prNumber" | "prUrl" | "previewUrl" | "activeSession">, agentName: string): string {
  const parts = ["The card moves to Done without merging anything."];
  if (card.activeSession) parts.push(`${agentName} stops working on it.`);
  if (card.previewUrl) parts.push("Its preview is taken down.");
  if (card.prNumber || card.prUrl) parts.push(`${card.prNumber ? `Pull request #${card.prNumber}` : "The pull request"} stays open on GitHub.`);
  return parts.join(" ");
}

/** GitHub's refusals come as fragments ("405 Repository rule violations found"); on the Card they read as a sentence. */
export function sentence(text: string): string {
  const t = text.trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** What the block asks of the reviewer, which depends on whether there is a preview to try. */
export function reviewGuidance(card: Pick<Card, "previewUrl"> & PreviewState): string {
  const preview = card.preview?.status;
  if (preview === "building") return "The preview is still building. Try it once it's up, then approve if it does what you asked.";
  if (preview === "failed") return "The preview didn't build, so look over the pull request instead, and approve if it does what you asked.";
  if (card.previewUrl) return "Try the preview, and approve if it does what you asked.";
  return "Look over the pull request, and approve if it does what you asked.";
}
