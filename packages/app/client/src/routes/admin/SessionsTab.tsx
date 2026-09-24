import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Square, RotateCcw, ChevronRight, X } from "lucide-react";
import { ACTIVE_SESSION_STATUSES, SESSION_STATUSES, type AdminSessionSummary, type SessionStatus } from "@kardboard/shared";
import { keys, request, useAdminBoards, useAdminSession, useAdminSessionPages, useAdminUsage, type AdminBoard } from "../../lib/api";
import { Button, Chip, EmptyState, ErrorState, Select, Skeleton, cx } from "../../components/ui";
import { absoluteTime, relativeTime, shortId } from "../../lib/format";
import { WorkingDot } from "../board/CardTile";
import { SessionTranscript } from "./SessionTranscript";
import { TabHeader } from "./AdminPage";
import {
  filterFromParams,
  formatCost,
  formatDuration,
  formatTokens,
  isFiltered,
  linkedOutsideList,
  NO_FILTER,
  paramsWithFilter,
  sessionDurationMs,
  totalTokens,
  usageBreakdown,
  usageSummary,
  type SessionsFilter,
} from "./sessionsView";

const TONE: Record<SessionStatus, "neutral" | "accent" | "ok" | "warn" | "danger" | "info"> = {
  queued: "info",
  starting: "accent",
  running: "accent",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  timed_out: "warn",
};

const statusLabel = (status: SessionStatus) => status.replace("_", " ");
const EASE = [0.16, 1, 0.3, 1] as const;

// Ticks once a second while a run on the page is still going, so its duration counts up.
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export function SessionsTab() {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParams(params);
  // The open Session lives in the address, so `/admin/sessions?session=<id>` links straight to it.
  const openId = params.get("session");
  const boards = useAdminBoards();
  const pages = useAdminSessionPages(filter);
  const sessions = useMemo(() => pages.data?.pages.flatMap((p) => p.sessions) ?? [], [pages.data]);
  const reduce = useReducedMotion();

  // The Session a link pointed at, as opposed to one opened by clicking its row here. It stays
  // linked after it is closed, so the list does not shift under the reader when they open another.
  const openedHere = useRef<string | null>(null);
  const [linkedId, setLinkedId] = useState<string | null>(openId);
  useEffect(() => {
    if (openId && openedHere.current !== openId) setLinkedId(openId);
  }, [openId]);
  const linkedOnPage = sessions.some((s) => s.id === linkedId);
  // Asked for on its own only when the loaded pages turn out not to have it.
  const linked = useAdminSession(linkedId && pages.data && !linkedOnPage ? linkedId : null);
  const outside = linkedOutsideList(sessions, linked.data);
  const now = useNow([...sessions, ...(outside ? [outside] : [])].some((s) => s.status === "running"));

  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: ({ id, rerun }: { id: string; rerun: boolean }) => request(`/admin/sessions/${id}/cancel${rerun ? "?rerun=1" : ""}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.adminSessions }),
  });

  const setFilter = (next: SessionsFilter) => setParams(paramsWithFilter(params, next), { replace: true });

  const toggle = (id: string) => {
    const next = new URLSearchParams(params);
    if (openId === id) next.delete("session");
    else next.set("session", id);
    openedHere.current = next.get("session");
    setParams(next, { replace: true });
  };

  // A linked Session is scrolled to and briefly marked once its row is on the page. One opened by
  // clicking is already where the reader is looking.
  const scrolledTo = useRef<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!linkedId || scrolledTo.current === linkedId) return;
    const row = document.getElementById(`session-${linkedId}`);
    if (!row) return;
    scrolledTo.current = linkedId;
    row.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setFlash(linkedId);
  }, [linkedId, linkedOnPage, outside?.id, reduce]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  const boardOf = (id: string) => boards.data?.find((b) => b.id === id);
  const row = (s: AdminSessionSummary) => (
    <SessionRow
      key={s.id}
      session={s}
      board={boardOf(s.boardId)}
      open={openId === s.id}
      flash={flash === s.id}
      now={now}
      onToggle={() => toggle(s.id)}
      onCancel={(rerun) => cancel.mutate({ id: s.id, rerun })}
    />
  );

  return (
    <>
      <TabHeader title="Sessions" body="Every agent run across all boards, newest first. Open one to read its transcript, which follows a running session live. The raw logs stay on disk for 14 days." />
      <UsageTotals boards={boards.data} onPick={(board) => setFilter({ ...filter, board })} />
      <Filters filter={filter} boards={boards.data} onChange={setFilter} />
      {linkedId && !linkedOnPage && linked.isError ? <ErrorState compact className="mb-4" title="Could not open the linked session." error={linked.error} /> : null}
      {outside ? (
        <div className="mb-5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Linked session</p>
          <ul className="rounded-card border border-line bg-surface">{row(outside)}</ul>
        </div>
      ) : null}
      {pages.isPending ? (
        <Skeleton className="h-40" />
      ) : !pages.data ? (
        // Only when there is nothing to show: a failed refresh keeps the list it already has.
        <ErrorState title="Could not load sessions." error={pages.error} onRetry={() => void pages.refetch()} retrying={pages.isFetching} />
      ) : sessions.length === 0 ? (
        isFiltered(filter) ? (
          <EmptyState
            title="No sessions match these filters"
            action={
              <Button size="sm" onClick={() => setFilter(NO_FILTER)}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState title="No sessions yet" body="A session starts about a minute after a member changes a card." />
        )
      ) : (
        <>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">{sessions.map(row)}</ul>
          {pages.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" size="sm" loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
          {pages.isFetchNextPageError ? <ErrorState compact className="mt-3" title="Could not load more sessions." error={pages.error} /> : null}
        </>
      )}
    </>
  );
}

function UsageTotals({ boards, onPick }: { boards: AdminBoard[] | undefined; onPick: (boardId: string) => void }) {
  const usage = useAdminUsage();
  const rows = usage.data?.boards.filter((b) => b.sessions > 0) ?? [];
  // Waits for the Board names too, rather than flashing ids in their place.
  if (!usage.data || !boards || rows.length === 0) return null;
  return (
    <section aria-labelledby="usage-heading" className="mb-6">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id="usage-heading" className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Last {usage.data.days} days
        </h2>
        <p className="text-[11.5px] text-ink-faint">As Claude Code reports it; cost is at API prices.</p>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((r) => {
          const unmeasured = r.sessions - r.measured;
          return (
            <li key={r.boardId} className="flex items-baseline gap-3 py-2 text-[13px]">
              <button
                type="button"
                title="Show this board's sessions"
                onClick={() => onPick(r.boardId)}
                className="min-w-0 flex-1 truncate text-left text-ink transition-colors duration-150 hover:text-accent"
              >
                {boards.find((b) => b.id === r.boardId)?.name ?? shortId(r.boardId)}
              </button>
              <span
                className="hidden shrink-0 font-mono text-[11.5px] text-ink-faint sm:inline"
                title={unmeasured > 0 ? "Codex sessions, and sessions stopped before they finished, report no usage." : undefined}
              >
                {r.sessions} {r.sessions === 1 ? "run" : "runs"}
                {unmeasured > 0 ? `, ${unmeasured} unmeasured` : ""}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[11.5px] text-ink-muted" title={usageBreakdown(r)}>
                {formatTokens(totalTokens(r))} tokens
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[12px] text-ink">{formatCost(r.costUsd)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Filters({ filter, boards, onChange }: { filter: SessionsFilter; boards: AdminBoard[] | undefined; onChange: (next: SessionsFilter) => void }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:items-center">
      <Select aria-label="Board" value={filter.board} onChange={(e) => onChange({ ...filter, board: e.target.value })} className="col-span-2 text-[13px] sm:w-44">
        <option value="">All boards</option>
        {boards?.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Status" value={filter.status} onChange={(e) => onChange({ ...filter, status: e.target.value as SessionsFilter["status"] })} className="text-[13px] sm:w-36">
        <option value="">Any status</option>
        <option value="active">Active</option>
        {SESSION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s).replace(/^./, (c) => c.toUpperCase())}
          </option>
        ))}
      </Select>
      <Select aria-label="Kind" value={filter.kind} onChange={(e) => onChange({ ...filter, kind: e.target.value as SessionsFilter["kind"] })} className="text-[13px] sm:w-40">
        <option value="">Cards and sweeps</option>
        <option value="card">Card sessions</option>
        <option value="sweep">Hygiene sweeps</option>
      </Select>
      {isFiltered(filter) ? (
        <Button size="sm" variant="ghost" className="col-span-2 justify-self-start" icon={<X className="size-3.5" strokeWidth={2} />} onClick={() => onChange(NO_FILTER)}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

function SessionRow({
  session: s,
  board,
  open,
  flash,
  now,
  onToggle,
  onCancel,
}: {
  session: AdminSessionSummary;
  board: AdminBoard | undefined;
  open: boolean;
  flash: boolean;
  now: number;
  onToggle: () => void;
  onCancel: (rerun: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const active = ACTIVE_SESSION_STATUSES.includes(s.status);
  const duration = sessionDurationMs(s, now);
  const title = s.kind === "sweep" ? "Hygiene sweep" : (s.cardTitle ?? (s.cardId ? `Card ${shortId(s.cardId)}` : "Card"));
  const actions = active ? (
    <>
      <Button size="sm" variant="ghost" icon={<Square className="size-3.5" strokeWidth={2} />} onClick={() => onCancel(false)}>
        Cancel
      </Button>
      <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" strokeWidth={2} />} onClick={() => onCancel(true)}>
        Re-run
      </Button>
    </>
  ) : null;
  const meta = "font-mono text-[11px] text-ink-faint";
  return (
    <li id={`session-${s.id}`} className={cx("scroll-mt-10 px-4 py-3 transition-colors duration-700 ease-out", flash ? "bg-accent-soft" : "bg-transparent")}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide transcript" : "Show transcript"}
          onClick={onToggle}
          className="mt-0.5 flex shrink-0 items-center gap-1 rounded-control text-ink-faint transition-colors duration-150 hover:text-ink"
        >
          <ChevronRight className={cx("size-3.5 transition-transform duration-150", open && "rotate-90")} strokeWidth={2} />
          <span className="w-4">{s.status === "running" ? <WorkingDot /> : null}</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13.5px]">
            {board && s.cardId ? (
              <Link to={`/b/${board.slug}/c/${s.cardId}`} className="min-w-0 truncate font-medium text-ink no-underline transition-colors duration-150 hover:text-accent">
                {title}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-medium text-ink">{title}</span>
            )}
            {board ? <span className="shrink-0 text-[12px] text-ink-faint">{board.name}</span> : null}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip tone={TONE[s.status]}>{statusLabel(s.status)}</Chip>
            <Chip>{s.provider === "claude" ? "Claude Code" : "Codex"}</Chip>
            <span className={meta}>{shortId(s.id)}</span>
            {duration !== null ? (
              <span className={cx(meta, "tabular-nums")} title={s.startedAt ? `Started ${absoluteTime(s.startedAt)}` : undefined}>
                {formatDuration(duration)}
              </span>
            ) : null}
            {s.usage ? (
              <span className="font-mono text-[11px] text-ink-muted" title={usageBreakdown(s.usage)}>
                {usageSummary(s.usage)}
              </span>
            ) : null}
            <span className={cx(meta, "sm:hidden")} title={absoluteTime(s.createdAt)}>
              {relativeTime(s.createdAt)}
            </span>
          </p>
          {s.intent ? <p className="mt-1.5 text-[12.5px] text-ink-muted">{s.intent}</p> : null}
          {s.outcomeSummary ? <p className="mt-0.5 text-[12.5px] text-ink-faint">{s.outcomeSummary}</p> : null}
          {/* On a phone the actions go under the text rather than beside it. */}
          {actions ? <div className="-ml-2.5 mt-1.5 flex gap-1 sm:hidden">{actions}</div> : null}
        </div>
        <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-ink-faint sm:block" title={absoluteTime(s.createdAt)}>
          {relativeTime(s.createdAt)}
        </span>
        {actions ? <span className="hidden shrink-0 gap-1 sm:flex">{actions}</span> : null}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="transcript"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <SessionTranscript sessionId={s.id} live={active} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
