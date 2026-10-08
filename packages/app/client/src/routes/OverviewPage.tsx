import type { ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DatabaseBackup, GitBranch, GitPullRequest, MessageCircleQuestion, Plus } from "lucide-react";
import { COLUMN_LABELS, type AgentProfile, type Board, type BoardSummary, type Card, type Column } from "@kardboard/shared";
import { useMe, useOverview } from "../lib/api";
import { useDocumentTitle } from "../lib/documentTitle";
import { relativeTime } from "../lib/format";
import { Avatar, cx, ErrorState, Skeleton } from "../components/ui";
import { TypeLabel } from "./board/cardTypes";

// Every Board at once, so nothing is lost across projects: what waits on the User, what is being
// worked on, and what reached Backlog lately, beside the Boards themselves. Each row opens its Card on
// its Board.
export function OverviewPage() {
  const overview = useOverview();
  const agent = useMe().data?.agent ?? { name: "Agent", avatarUrl: null };
  useDocumentTitle("Overview · kardboard");
  if (overview.isPending) return <OverviewSkeleton />;
  if (!overview.data) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <ErrorState title="Could not load the overview." error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} />
      </div>
    );
  }
  const { boards, needsYou, inProgress, backlog, backlogTotal, backupProblem } = overview.data;
  const boardOf = new Map(boards.map((b) => [b.board.id, b.board]));
  if (boards.length === 0) return <NoBoards />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-x-12 gap-y-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-10">
          {backupProblem ? <BackupProblem message={backupProblem} /> : null}
          <Section title="Needs you" count={needsYou.length} empty="Nothing waits on you. Questions and pull requests show up here.">
            {needsYou.map((card) => (
              <CardRow key={card.id} card={card} board={boardOf.get(card.boardId)} agent={agent} why={card.column === "review" ? "review" : "question"} />
            ))}
          </Section>
          <Section title="In progress" count={inProgress.length} empty="Nothing is being worked on.">
            {inProgress.map((card) => (
              <CardRow key={card.id} card={card} board={boardOf.get(card.boardId)} agent={agent} />
            ))}
          </Section>
          <Section
            title="New in Backlog"
            count={backlogTotal}
            empty="Backlog is empty everywhere. What you or your agents file lands here."
            footer={backlogTotal > backlog.length ? `${backlogTotal - backlog.length} older in Backlog across your boards.` : null}
          >
            {backlog.map((card) => (
              <CardRow key={card.id} card={card} board={boardOf.get(card.boardId)} agent={agent} age="created" />
            ))}
          </Section>
        </div>
        <BoardList boards={boards} />
      </div>
    </div>
  );
}

// Backups fail where no one is looking, and nothing emails about it, so the page every visit starts on
// says so until the next one succeeds.
function BackupProblem({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-card border border-warn/30 bg-[rgba(217,178,108,0.07)] px-3.5 py-3 text-[13px] leading-relaxed">
      <DatabaseBackup className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.75} aria-hidden="true" />
      <p className="min-w-0 flex-1 text-ink">
        {message}{" "}
        <Link to="/settings/backups" className="whitespace-nowrap text-accent">
          Open Backups
        </Link>
      </p>
    </div>
  );
}

function Section({ title, count, empty, footer, children }: { title: string; count: number; empty: string; footer?: string | null; children: ReactNode }) {
  const id = `overview-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-2.5 flex items-baseline gap-2 text-[14px] font-semibold tracking-tight text-ink">
        {title}
        <span className="font-mono text-[12px] font-normal text-ink-faint">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-5 text-[13px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>{children}</AnimatePresence>
        </ul>
      )}
      {footer ? <p className="mt-2 text-[12.5px] text-ink-faint">{footer}</p> : null}
    </section>
  );
}

// One Card on one line: its type, title, and Board, why it is here, and how fresh it is. Live updates
// slide rows in and out rather than reshuffling the list under the pointer.
function CardRow({ card, board, agent, why, age = "updated" }: { card: Card; board: Board | undefined; agent: AgentProfile; why?: "question" | "review"; age?: "created" | "updated" }) {
  const reduce = useReducedMotion();
  const when = age === "created" ? card.createdAt : card.updatedAt;
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <Link
        to={board ? `/b/${board.slug}/c/${card.id}` : "/"}
        className="group flex items-center gap-3 rounded-card border border-line bg-surface px-3 py-2.5 no-underline transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-raised"
      >
        <TypeLabel type={card.type} iconOnly className="shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-ink">{card.title}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-faint">
            <span className="truncate">{board?.name ?? "A deleted board"}</span>
            {why === "question" ? (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-warn">
                <MessageCircleQuestion className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                Needs your answer
              </span>
            ) : why === "review" ? (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-accent">
                <GitPullRequest className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                {card.prNumber ? `#${card.prNumber} to review` : "To review"}
              </span>
            ) : null}
          </p>
        </div>
        {card.creatorKind === "agent" ? <Avatar name={agent.name} url={agent.avatarUrl} size={18} tone="agent" className="shrink-0" /> : null}
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-faint" title={`${age === "created" ? "Created" : "Updated"} ${new Date(when).toLocaleString()}`}>
          {relativeTime(when)}
        </span>
      </Link>
    </motion.li>
  );
}

const COUNTED: Exclude<Column, "done">[] = ["inbox", "blocked", "ready", "in_progress", "review"];

function BoardList({ boards }: { boards: BoardSummary[] }) {
  return (
    <aside aria-labelledby="overview-boards" className="min-w-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 id="overview-boards" className="flex items-baseline gap-2 text-[14px] font-semibold tracking-tight text-ink">
          Boards
          <span className="font-mono text-[12px] font-normal text-ink-faint">{boards.length}</span>
        </h2>
        <Link to="/settings/boards" className="inline-flex items-center gap-1 text-[12.5px] text-ink-muted no-underline transition-colors hover:text-ink">
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          New board
        </Link>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
        {boards.map(({ board, open, needsYou }) => {
          const counts = COUNTED.filter((col) => open[col] > 0);
          return (
            <li key={board.id}>
              <Link to={`/b/${board.slug}`} className="block px-3.5 py-3 no-underline transition-colors first:rounded-t-card last:rounded-b-card hover:bg-raised">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{board.name}</span>
                  {needsYou > 0 ? (
                    <span className="shrink-0 rounded-full bg-[rgba(217,178,108,0.14)] px-1.5 font-mono text-[11px] leading-5 text-warn" title={`${needsYou} waiting on you`}>
                      {needsYou}
                    </span>
                  ) : null}
                </span>
                {board.repoUrl ? (
                  <span className="mt-0.5 flex items-center gap-1 truncate font-mono text-[11.5px] text-ink-faint">
                    <GitBranch className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    {board.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                  </span>
                ) : null}
                <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-muted">
                  {counts.length === 0 ? (
                    <span className="text-ink-faint">Nothing open</span>
                  ) : (
                    counts.map((col) => (
                      <span key={col}>
                        <span className={cx("font-mono", col === "blocked" ? "text-warn" : "text-ink")}>{open[col]}</span> {COLUMN_LABELS[col].toLowerCase()}
                      </span>
                    ))
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function NoBoards() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 px-6 py-16">
      <h1 className="text-lg font-semibold text-ink">No boards yet</h1>
      <p className="text-[13.5px] leading-relaxed text-ink-muted">
        Make one board per project in Settings, or connect an agent and ask it to make one for the repository it is working in.
      </p>
      <div className="flex gap-4 text-[13px]">
        <Link to="/settings/boards" className="text-accent">
          Create a board
        </Link>
        <Link to="/settings/agent" className="text-accent">
          Connect an agent
        </Link>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-x-12 gap-y-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-10">
        {[3, 2, 4].map((rows, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="mb-1 h-4 w-28" />
            {Array.from({ length: rows }, (_, j) => (
              <Skeleton key={j} className="h-[54px]" />
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="mb-1 h-4 w-20" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
