import { DatabaseBackup } from "lucide-react";
import type { BackupsView } from "@kardboard/shared";
import { useAdminBackups, useTakeBackup } from "../../lib/api";
import { Button, Chip, EmptyState, ErrorState, Skeleton } from "../../components/ui";
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
          <OffDiskCopy view={view} />
          {view.snapshots.length === 0 ? (
            <EmptyState title="No snapshots yet" body="The first one is written when the server next reaches the scheduled hour, or now with the button above." />
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {view.snapshots.map((s) => (
                <li key={s.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{s.name}</span>
                  {s.kind === "pre_migrate" ? <Chip className="hidden shrink-0 sm:inline-flex">before migrating</Chip> : null}
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

// Where snapshots and attachments are copied off the data disk, and how the last copy went.
function OffDiskCopy({ view }: { view: BackupsView }) {
  if (!view.copyDir) {
    return <p className="mb-4 text-[13px] text-ink-faint">Snapshots are not copied off this disk. Set KARDBOARD_BACKUP_COPY_DIR to keep a second copy, with attachments, somewhere else.</p>;
  }
  const last = view.lastCopy;
  return (
    <p className="mb-4 text-[13px] text-ink-muted">
      Each snapshot and any new attachments are copied to <span className="font-mono text-[12px]">{view.copyDir}</span>.{" "}
      {!last ? (
        "Nothing has been copied yet."
      ) : last.ok ? (
        <span title={absoluteTime(last.at)}>
          The last copy, <span className="font-mono text-[12px]">{last.snapshot}</span>, went through {relativeTime(last.at)}
          {last.uploadsCopied > 0 ? ` with ${last.uploadsCopied} new ${last.uploadsCopied === 1 ? "attachment" : "attachments"}` : ""}.
        </span>
      ) : (
        <span className="text-danger" title={absoluteTime(last.at)}>
          The last copy failed {relativeTime(last.at)}: {last.error}
        </span>
      )}
    </p>
  );
}
