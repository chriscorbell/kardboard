import type { Card, SessionSummary, WaitingReason } from "@kardboard/shared";

// What a Card and its Board say about the Agent's work: the banner at the top of the card sheet,
// the small mark on a tile, and the agent pill in the board toolbar. Plain functions, so the rules
// are tested without rendering; the components only lay the answers out.

export type SessionBanner =
  | { kind: "active"; session: SessionSummary }
  | { kind: "waiting"; reason: WaitingReason; since: string }
  | { kind: "stopped"; session: SessionSummary }
  | null;

type BannerCard = Pick<Card, "activeSession" | "waiting" | "lastSession" | "column" | "pendingRerun" | "updatedAt">;

/**
 * Which banner the card sheet shows. A Session at work outranks everything; then whatever the Card
 * is waiting for; then a last run that stopped short, which offers Try again. A Card in Done has
 * nothing left to try, and a Card whose last run finished has nothing to say.
 */
export function sessionBanner(card: BannerCard): SessionBanner {
  if (card.activeSession) return { kind: "active", session: card.activeSession };
  if (card.waiting) return { kind: "waiting", ...card.waiting };
  // Changes queued behind a Session that has just ended, in the moment before the next one claims.
  if (card.pendingRerun) return { kind: "waiting", reason: "coalescing", since: card.updatedAt };
  const last = card.lastSession;
  if (last && (last.status === "failed" || last.status === "timed_out") && card.column !== "done") return { kind: "stopped", session: last };
  return null;
}

export function waitingMessage(reason: WaitingReason, agentName: string): { title: string; detail: string | null } {
  switch (reason) {
    case "coalescing":
      return { title: `${agentName} will pick this up shortly`, detail: null };
    case "slot":
      return { title: "Waiting for a free slot", detail: `${agentName} starts as soon as another session finishes.` };
    case "paused":
      return { title: "Paused by the Admin", detail: `${agentName} starts no new work on this board until it is resumed.` };
    case "retrying":
      return { title: `${agentName} could not start`, detail: "It will try again in a few minutes." };
  }
}

/** Why a stopped Session stopped, in the words its Card's people read. */
export function stoppedReason(session: Pick<SessionSummary, "status" | "startedAt" | "outcomeSummary">): string {
  // A start the runner refused carries the runner's own error, which is for the Admin.
  if (session.status === "failed" && !session.startedAt) return "It could not start.";
  if (session.outcomeSummary?.trim()) return session.outcomeSummary.trim();
  return session.status === "timed_out" ? "It ran out of time." : "It stopped unexpectedly.";
}

/** The Admin's link to a Session's transcript in the admin panel. */
export function transcriptHref(sessionId: string): string {
  return `/admin/sessions?session=${encodeURIComponent(sessionId)}`;
}

/** The mark a tile shows for a Card with no Session yet, and its words for a tooltip and a screen reader. */
export function tileWaiting(card: Pick<Card, "activeSession" | "waiting">, agentName: string): { reason: WaitingReason; label: string } | null {
  if (card.activeSession || !card.waiting) return null;
  return { reason: card.waiting.reason, label: waitingMessage(card.waiting.reason, agentName).title };
}

/** `short` is for a phone's toolbar, where the full label would wrap. */
export type AgentPillState = { tone: "paused" | "working" | "idle"; label: string; short: string };

/** What the toolbar says the Agent is doing on this Board. A pause is said even while Sessions finish. */
export function agentPill(input: { agentName: string; paused: boolean; working: number }): AgentPillState {
  const cards = (n: number) => (n === 1 ? "1 card" : `${n} cards`);
  if (input.paused) {
    const label = input.working > 0 ? `${input.agentName} is paused on this board, finishing ${cards(input.working)}` : `${input.agentName} is paused on this board`;
    return { tone: "paused", label, short: `${input.agentName} is paused` };
  }
  // The pill's avatar already names the Agent, so a phone drops the name.
  if (input.working > 0) return { tone: "working", label: `${input.agentName} is working on ${cards(input.working)}`, short: `Working on ${cards(input.working)}` };
  const label = `${input.agentName} is idle`;
  return { tone: "idle", label, short: label };
}
