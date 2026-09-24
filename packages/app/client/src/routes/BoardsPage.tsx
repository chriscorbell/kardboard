import { Link, Navigate } from "react-router";
import { ArrowRight, Bot, GitBranch } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useBoards, useMe } from "../lib/api";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";

export function BoardsPage() {
  const boards = useBoards();
  const me = useMe();
  const reduce = useReducedMotion();
  if (boards.isPending) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Skeleton className="mb-6 h-6 w-40" />
        <div className="grid gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </div>
    );
  }
  if (!boards.data) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <ErrorState title="Could not load your boards." error={boards.error} onRetry={() => void boards.refetch()} retrying={boards.isFetching} />
      </div>
    );
  }
  if (boards.data.length === 1) return <Navigate to={`/b/${boards.data[0]!.slug}`} replace />;
  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-lg font-semibold">Boards</h1>
      <p className="mb-6 text-sm text-ink-muted">{boards.data.length === 0 ? "Nothing here yet." : "One board per project. Open one to see its cards."}</p>
      {boards.data.length === 0 ? (
        <EmptyState
          title="No boards yet"
          body={me.data?.user.role === "admin" ? "Create a board from the admin panel and grant members access to it." : "You have not been added to a board. Ask the person who invited you."}
          action={me.data?.user.role === "admin" ? <Link to="/admin/boards" className="text-sm text-accent">Open admin</Link> : undefined}
        />
      ) : (
        <ul className="grid gap-2">
          {boards.data.map((b, i) => (
            <motion.li key={b.id} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}>
              <Link to={`/b/${b.slug}`} className="group flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3.5 no-underline transition-colors hover:border-line-strong hover:bg-raised">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-ink">{b.name}</p>
                  <p className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-faint">
                    {b.repoUrl ? (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <GitBranch className="size-3.5" strokeWidth={1.75} />
                        {b.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1">
                      <Bot className="size-3.5" strokeWidth={1.75} />
                      {b.provider === "claude" ? "Claude Code" : "Codex"}
                    </span>
                  </p>
                </div>
                <ArrowRight className="size-4 text-ink-faint transition-transform duration-200 ease-out-expo group-hover:translate-x-0.5 group-hover:text-ink" strokeWidth={1.75} />
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
