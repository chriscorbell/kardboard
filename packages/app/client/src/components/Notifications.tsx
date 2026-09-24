import { useNavigate } from "react-router";
import { Bell } from "lucide-react";
import type { Notification } from "@kardboard/shared";
import { useMarkNotificationsRead, useNotifications } from "../lib/api";
import { relativeTime } from "../lib/format";
import { Popover } from "./Popover";
import { Avatar, cx } from "./ui";

// Above this the badge stops counting; the panel still lists everything.
const BADGE_MAX = 9;

export function badgeLabel(unread: number): string {
  return unread > BADGE_MAX ? `${BADGE_MAX}+` : String(unread);
}

export function Notifications() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.notifications ?? [];

  const open = (n: Notification, close: () => void) => {
    if (!n.readAt) markRead.mutate([n.id]);
    navigate(`/b/${n.boardSlug}/c/${n.cardId}`);
    close();
  };

  return (
    <Popover
      align="right"
      className="w-[min(22rem,calc(100vw-1.5rem))]"
      onOpen={() => void notifications.refetch()}
      trigger={
        <button
          className="relative inline-flex size-8 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" strokeWidth={1.75} />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink">
              {badgeLabel(unread)}
            </span>
          ) : null}
        </button>
      }
    >
      {(close) => (
        <div className="flex max-h-[min(26rem,70vh)] flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="text-[13px] font-medium text-ink">Notifications</span>
            {unread > 0 ? (
              <button className="text-[12px] text-ink-muted transition-colors hover:text-ink" onClick={() => markRead.mutate(undefined)}>
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-ink-faint">
                {notifications.isPending ? "Loading…" : "Nothing yet. Mentions and moves on your cards land here."}
              </p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => open(n, close)}
                  className={cx(
                    "flex w-full gap-2.5 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-overlay",
                    !n.readAt && "bg-accent-soft",
                  )}
                >
                  <Avatar name={n.actorName} url={n.actorAvatarUrl} size={24} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{n.title}</span>
                      <span className="shrink-0 text-[11px] text-ink-faint">{relativeTime(n.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] font-medium text-ink-muted">{n.cardTitle}</span>
                    {n.body ? <span className="mt-0.5 block line-clamp-2 text-[12px] text-ink-faint">{n.body}</span> : null}
                  </span>
                  {!n.readAt ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
