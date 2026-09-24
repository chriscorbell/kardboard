import { DatabaseBackup } from "lucide-react";
import { useAdminBackups, useTakeBackup } from "../../lib/api";
import { Button, EmptyState, ErrorState, Skeleton } from "../../components/ui";
import { absoluteTime, fileSize, relativeTime } from "../../lib/format";
import { TabHeader } from "./AdminPage";

export function BackupsTab() {
  const backups = useAdminBackups();
  const take = useTakeBackup();
  const view = backups.data;
  const schedule = !view ? "" : view.hour < 0 ? "Scheduled snapshots are off." : `A snapshot is taken daily at ${String(view.hour).padStart(2, "0")}:00 server time, and the newest ${view.keep} are kept.`;
  return (
    <>
      <TabHeader
        title="Backups"
        body="Each snapshot is a verified, self-contained copy of the database written with VACUUM INTO, never a copy of the live file. Restoring one is done on the host with the app stopped; see docs/runbooks/backups.md."
        action={
          <Button variant="primary" icon={<DatabaseBackup className="size-4" strokeWidth={1.75} />} loading={take.isPending} onClick={() => take.mutate()}>
            Snapshot now
          </Button>
        }
      />
      {take.isError ? <p className="mb-4 text-[13px] text-danger">Snapshot failed: {(take.error as Error).message}</p> : null}
      {backups.isPending ? (
        <Skeleton className="h-40" />
      ) : !view ? (
        <ErrorState title="Could not load backups." error={backups.error} onRetry={() => void backups.refetch()} retrying={backups.isFetching} />
      ) : (
        <>
          <p className="mb-4 text-[13px] text-ink-muted">
            {schedule} Database <span className="font-mono text-[12px]">{fileSize(view.databaseBytes)}</span>, snapshots in <span className="font-mono text-[12px]">{view.dir}</span>.
          </p>
          {view.lastAttempt && !view.lastAttempt.ok ? (
            <p className="mb-4 text-[13px] text-danger" title={absoluteTime(view.lastAttempt.at)}>
              The last snapshot failed {relativeTime(view.lastAttempt.at)}: {view.lastAttempt.error}
            </p>
          ) : null}
          {view.snapshots.length === 0 ? (
            <EmptyState title="No snapshots yet" body="The first one is written when the server next reaches the scheduled hour, or now with the button above." />
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {view.snapshots.map((s) => (
                <li key={s.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{s.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">{fileSize(s.bytes)}</span>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] text-ink-faint" title={absoluteTime(s.takenAt)}>
                    {relativeTime(s.takenAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
