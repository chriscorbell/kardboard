import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCcw, ScrollText, Square } from "lucide-react";
import type { Card } from "@kardboard/shared";
import { keys, request, useRetryCard } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { Button, cx } from "../../components/ui";
import { WaitingMark, WorkingDot } from "./CardTile";
import { sessionBanner, stoppedReason, transcriptHref, waitingMessage } from "./sessionStatus";

const EASE = [0.16, 1, 0.3, 1] as const;

// The top of the card sheet: what the Agent is doing with this Card right now. A Session at work,
// what the Card is waiting for, or a last run that stopped short with Try again. The Admin also
// gets the Session's controls and a link to its transcript.
export function SessionBanner({ slug, card, agentName, isAdmin }: { slug: string; card: Card; agentName: string; isAdmin: boolean }) {
  const reduce = useReducedMotion();
  const qc = useQueryClient();
  const retry = useRetryCard(slug);
  const banner = sessionBanner(card);
  // One key per state, so a change of state reads as a change rather than an edit in place.
  const key = banner ? (banner.kind === "waiting" ? `waiting-${banner.reason}` : `${banner.kind}-${banner.session.id}`) : "none";

  return (
    <AnimatePresence initial={false} mode="wait">
      {banner ? (
        <motion.div
          key={key}
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: EASE }}
          className={cx(
            "mx-6 mt-4 rounded-card border px-3.5 py-3",
            banner.kind === "active" ? "border-accent/25 bg-accent-soft" : banner.kind === "stopped" ? "border-danger/30 bg-[rgba(217,130,116,0.08)]" : "border-line bg-bg",
          )}
        >
          {banner.kind === "active" ? (
            <div className="flex items-start gap-2.5">
              <WorkingDot className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-accent">
                  {agentName} {banner.session.status === "queued" ? "is starting a session" : "is working on this"}
                  {banner.session.startedAt ? <span className="font-normal text-accent/70"> since {relativeTime(banner.session.startedAt)}</span> : null}
                </p>
                {banner.session.intent ? <p className="mt-0.5 text-[13px] text-ink-muted">{banner.session.intent}</p> : null}
                {card.pendingRerun ? <p className="mt-1 text-[12px] text-ink-faint">Your latest changes are queued for the next session.</p> : null}
              </div>
              {isAdmin ? (
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  <TranscriptLink sessionId={banner.session.id} />
                  <Button size="sm" variant="ghost" icon={<Square className="size-3.5" strokeWidth={2} />} onClick={() => void cancelSession(banner.session.id, false, qc, slug, card.id)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" strokeWidth={2} />} onClick={() => void cancelSession(banner.session.id, true, qc, slug, card.id)}>
                    Re-run
                  </Button>
                </span>
              ) : null}
            </div>
          ) : banner.kind === "waiting" ? (
            <WaitingBody reason={banner.reason} since={banner.since} agentName={agentName} />
          ) : (
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">
                      {agentName} stopped before finishing
                      {banner.session.endedAt ? <span className="font-normal text-ink-faint"> {relativeTime(banner.session.endedAt)}</span> : null}
                    </p>
                    <p className="mt-0.5 text-[13px] text-ink-muted">{stoppedReason(banner.session)}</p>
                  </div>
                </div>
                <span className="flex shrink-0 gap-1 pl-6 sm:pl-0">
                  {isAdmin ? <TranscriptLink sessionId={banner.session.id} /> : null}
                  <Button size="sm" icon={<RotateCcw className="size-3.5" strokeWidth={2} />} loading={retry.isPending} onClick={() => retry.mutate(card.id)}>
                    Try again
                  </Button>
                </span>
              </div>
              {retry.error ? (
                <p role="alert" className="mt-2.5 border-t border-danger/20 pt-2 text-[12.5px] text-danger">
                  {retry.error.message}
                </p>
              ) : null}
            </div>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function WaitingBody({ reason, since, agentName }: { reason: Parameters<typeof waitingMessage>[0]; since: string; agentName: string }) {
  const message = waitingMessage(reason, agentName);
  // How long it has waited matters once the wait is out of the person's hands.
  const showSince = reason === "slot" || reason === "paused";
  return (
    <div className="flex items-start gap-2.5">
      <WaitingMark reason={reason} className="mt-1" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-ink">
          {message.title}
          {showSince ? <span className="font-normal text-ink-faint"> since {relativeTime(since)}</span> : null}
        </p>
        {message.detail ? <p className="mt-0.5 text-[13px] text-ink-muted">{message.detail}</p> : null}
      </div>
    </div>
  );
}

function TranscriptLink({ sessionId }: { sessionId: string }) {
  return (
    <Link
      to={transcriptHref(sessionId)}
      className="inline-flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium text-ink-muted no-underline transition-colors duration-150 hover:bg-raised hover:text-ink"
    >
      <ScrollText className="size-3.5" strokeWidth={2} aria-hidden="true" />
      Transcript
    </Link>
  );
}

async function cancelSession(id: string, rerun: boolean, qc: ReturnType<typeof useQueryClient>, slug: string, cardId: string) {
  await request(`/admin/sessions/${id}/cancel${rerun ? "?rerun=1" : ""}`, { method: "POST" });
  await qc.invalidateQueries({ queryKey: keys.board(slug) });
  await qc.invalidateQueries({ queryKey: keys.card(cardId) });
}
