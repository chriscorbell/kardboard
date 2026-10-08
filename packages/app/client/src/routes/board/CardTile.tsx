import { forwardRef, type HTMLAttributes } from "react";
import { GitPullRequest, MessageCircleQuestion, MessageSquare } from "lucide-react";
import type { AgentProfile, Card, Person } from "@kardboard/shared";
import { Avatar, cx } from "../../components/ui";

const PRIORITY: Record<Card["priority"], { label: string; className: string } | null> = {
  none: null,
  low: { label: "Low", className: "text-ink-faint" },
  medium: { label: "Medium", className: "text-warn" },
  high: { label: "High", className: "text-danger" },
};

type Props = HTMLAttributes<HTMLDivElement> & {
  card: Card;
  creator: Person | undefined;
  agent: AgentProfile;
  dragging?: boolean;
  overlay?: boolean;
};

export const CardTile = forwardRef<HTMLDivElement, Props>(function CardTile({ card, creator, agent, dragging, overlay, className, ...rest }, ref) {
  const priority = PRIORITY[card.priority];
  return (
    <div
      ref={ref}
      className={cx(
        "group relative select-none rounded-card border bg-surface px-3 py-2.5 transition-[border-color,box-shadow] duration-150 ease-out-expo",
        dragging ? "opacity-40" : "opacity-100",
        // Lifted: its shadow comes up as it is picked up, and the drop lays it back down.
        overlay ? "animate-[card-lift_150ms_ease-out] border-line-strong shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]" : "border-line hover:border-line-strong hover:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.6)]",
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
          {creator ? <Avatar name={creator.name} url={creator.avatarUrl} size={20} /> : card.creatorKind === "agent" ? <Avatar name={agent.name} url={agent.avatarUrl} size={20} tone="agent" /> : null}
        </span>
      </div>
    </div>
  );
});
