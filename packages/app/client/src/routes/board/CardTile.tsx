import { forwardRef, type HTMLAttributes } from "react";
import { GitPullRequest, MessageCircleQuestion, MessageSquare, Pause, RotateCcw } from "lucide-react";
import type { AgentProfile, Card, Person, WaitingReason } from "@kardboard/shared";
import { Avatar, cx } from "../../components/ui";
import { tileWaiting } from "./sessionStatus";

const PRIORITY: Record<Card["priority"], { label: string; className: string } | null> = {
  none: null,
  low: { label: "Low", className: "text-ink-faint" },
  medium: { label: "Medium", className: "text-warn" },
  high: { label: "High", className: "text-danger" },
};

export function WorkingDot({ className }: { className?: string }) {
  return (
    <span className={cx("relative inline-flex size-2", className)} aria-hidden="true">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 [animation-duration:1.8s]" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

// The working dot's quieter sibling: a hollow ring for a Card that will start, in the accent while
// its batch collects and faint while it waits on a slot or a retry, and the pause glyph on a paused
// Board. Still rather than pulsing, since nothing is running yet.
export function WaitingMark({ reason, className }: { reason: WaitingReason; className?: string }) {
  if (reason === "paused") return <Pause className={cx("size-3 text-ink-muted", className)} strokeWidth={2.25} aria-hidden="true" />;
  return <span className={cx("inline-flex size-2 shrink-0 rounded-full border-[1.5px]", reason === "coalescing" ? "border-accent" : "border-ink-faint", className)} aria-hidden="true" />;
}

type Props = HTMLAttributes<HTMLDivElement> & {
  card: Card;
  creator: Person | undefined;
  agent: AgentProfile;
  dragging?: boolean;
  overlay?: boolean;
};

export const CardTile = forwardRef<HTMLDivElement, Props>(function CardTile({ card, creator, agent, dragging, overlay, className, ...rest }, ref) {
  const priority = PRIORITY[card.priority];
  const working = card.activeSession && card.activeSession.status !== "queued";
  const queued = card.activeSession?.status === "queued";
  const waiting = tileWaiting(card, agent.name);
  return (
    <div
      ref={ref}
      className={cx(
        "group relative select-none rounded-card border bg-surface px-3 py-2.5 transition-[border-color,box-shadow,transform,opacity] duration-150 ease-out-expo",
        dragging ? "opacity-40" : "opacity-100",
        overlay ? "rotate-[1.5deg] border-line-strong shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]" : "border-line hover:border-line-strong hover:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.6)]",
        className,
      )}
      {...rest}
    >
      <p className="line-clamp-3 text-[13.5px] font-medium leading-snug text-ink">{card.title}</p>
      {card.column === "blocked" && card.awaitingReply ? (
        <p className="mt-1.5 flex items-center gap-1 text-[12px] font-medium text-warn" title={`${agent.name} asked a question`}>
          <MessageCircleQuestion className="size-3.5 shrink-0" strokeWidth={1.75} />
          Needs your answer
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2.5 text-[12px] text-ink-faint">
        {priority ? <span className={cx("font-medium", priority.className)}>{priority.label}</span> : null}
        {card.commentCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" strokeWidth={1.75} />
            {card.commentCount}
          </span>
        ) : null}
        {card.prNumber ? (
          <span className="inline-flex items-center gap-1 font-mono">
            <GitPullRequest className="size-3.5" strokeWidth={1.75} />#{card.prNumber}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {working ? (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <WorkingDot />
              {agent.name}
            </span>
          ) : queued ? (
            <span className="text-ink-muted">Starting</span>
          ) : waiting ? (
            <span className="inline-flex size-3.5 items-center justify-center" title={waiting.label}>
              <WaitingMark reason={waiting.reason} />
              <span className="sr-only">{waiting.label}</span>
            </span>
          ) : card.pendingRerun ? (
            <span className="inline-flex items-center gap-1 text-ink-muted" title="Changes queued for the next session">
              <RotateCcw className="size-3.5" strokeWidth={1.75} />
            </span>
          ) : null}
          {creator ? <Avatar name={creator.name} url={creator.avatarUrl} size={20} /> : card.creatorKind === "agent" ? <Avatar name={agent.name} url={agent.avatarUrl} size={20} tone="agent" /> : null}
        </span>
      </div>
    </div>
  );
});
