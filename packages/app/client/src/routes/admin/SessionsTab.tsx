import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Square, RotateCcw, ChevronRight } from "lucide-react";
import { ACTIVE_SESSION_STATUSES, type SessionStatus } from "@kardboard/shared";
import { keys, request, useAdminBoards, useAdminSessions } from "../../lib/api";
import { Button, Chip, EmptyState, Skeleton, cx } from "../../components/ui";
import { absoluteTime, relativeTime, shortId } from "../../lib/format";
import { WorkingDot } from "../board/CardTile";
import { SessionTranscript } from "./SessionTranscript";
import { TabHeader } from "./AdminPage";

const TONE: Record<SessionStatus, "neutral" | "accent" | "ok" | "warn" | "danger" | "info"> = {
  queued: "info",
  starting: "accent",
  running: "accent",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  timed_out: "warn",
};

export function SessionsTab() {
  const sessions = useAdminSessions();
  const boards = useAdminBoards();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: ({ id, rerun }: { id: string; rerun: boolean }) => request(`/admin/sessions/${id}/cancel${rerun ? "?rerun=1" : ""}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.adminSessions }),
  });
  const boardOf = (id: string) => boards.data?.find((b) => b.id === id);
  return (
    <>
      <TabHeader title="Sessions" body="Every agent run across all boards, newest first. Click one to read its transcript, which follows a running session live. The raw logs stay on disk for 14 days." />
      {sessions.isPending ? (
        <Skeleton className="h-40" />
      ) : sessions.data && sessions.data.length === 0 ? (
        <EmptyState title="No sessions yet" body="A session starts about a minute after a member changes a card." />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {sessions.data?.map((s) => {
            const active = ACTIVE_SESSION_STATUSES.includes(s.status);
            const board = boardOf(s.boardId);
            const open = expanded === s.id;
            return (
              <li key={s.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={open ? "Hide transcript" : "Show transcript"}
                    onClick={() => setExpanded(open ? null : s.id)}
                    className="mt-0.5 flex shrink-0 items-center gap-1 rounded-control text-ink-faint transition-colors duration-150 hover:text-ink"
                  >
                    <ChevronRight className={cx("size-3.5 transition-transform duration-150", open && "rotate-90")} strokeWidth={2} />
                    <span className="w-4">{s.status === "running" ? <WorkingDot /> : null}</span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                      <span className="font-mono text-[11.5px] text-ink-faint">{shortId(s.id)}</span>
                      <Chip tone={TONE[s.status]}>{s.status.replace("_", " ")}</Chip>
                      <Chip>{s.kind === "sweep" ? "sweep" : s.provider === "claude" ? "Claude Code" : "Codex"}</Chip>
                      {board ? (
                        s.cardId ? (
                          <Link to={`/b/${board.slug}/c/${s.cardId}`} className="text-ink no-underline hover:text-accent">
                            {board.name}
                          </Link>
                        ) : (
                          <span className="text-ink">{board.name}</span>
                        )
                      ) : null}
                    </p>
                    {s.intent ? <p className="mt-1 text-[12.5px] text-ink-muted">{s.intent}</p> : null}
                    {s.outcomeSummary ? <p className="mt-0.5 text-[12.5px] text-ink-faint">{s.outcomeSummary}</p> : null}
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] text-ink-faint" title={absoluteTime(s.createdAt)}>
                    {relativeTime(s.createdAt)}
                  </span>
                  {active ? (
                    <span className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" icon={<Square className="size-3.5" strokeWidth={2} />} onClick={() => cancel.mutate({ id: s.id, rerun: false })}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" strokeWidth={2} />} onClick={() => cancel.mutate({ id: s.id, rerun: true })}>
                        Re-run
                      </Button>
                    </span>
                  ) : null}
                </div>
                {open ? <SessionTranscript sessionId={s.id} live={active} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
