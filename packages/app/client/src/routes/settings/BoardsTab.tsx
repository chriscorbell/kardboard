import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Board, BoardDeletionImpact } from "@kardboard/shared";
import { keys, request, useAdminBoards } from "../../lib/api";
import { Button, ErrorState, Field, Input, Skeleton } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { TabHeader } from "./SettingsPage";
import { slugDraft, slugify } from "./slug";
import { canDelete, deletionContents } from "./boardDeletion";
import { toast } from "../../lib/toast";

type Draft = {
  name: string;
  slug: string;
  repoUrl: string;
};

const empty: Draft = { name: "", slug: "", repoUrl: "" };

function fromBoard(b: Board): Draft {
  return { name: b.name, slug: b.slug, repoUrl: b.repoUrl ?? "" };
}

export function BoardsTab() {
  const boards = useAdminBoards();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Board | "new" | null>(null);
  const [deleting, setDeleting] = useState<Board | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  // A new board's slug follows its name until the slug is typed into by hand.
  const [slugTyped, setSlugTyped] = useState(false);
  useEffect(() => {
    if (editing === "new") setDraft(empty);
    else if (editing) setDraft(fromBoard(editing));
    setSlugTyped(false);
  }, [editing]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name,
        slug: slugify(draft.slug),
        repoUrl: draft.repoUrl || null,
      };
      if (editing === "new") await request<Board>("/admin/boards", { method: "POST", body: JSON.stringify(body) });
      else await request<Board>(`/admin/boards/${(editing as Board).id}`, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.adminBoards });
      void qc.invalidateQueries({ queryKey: keys.boards });
      setEditing(null);
    },
  });

  return (
    <>
      <TabHeader
        title="Boards"
        body="One board per project, with its repository, so your agents can find the board for the code they're working in."
        action={
          <Button variant="primary" icon={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setEditing("new")}>
            New board
          </Button>
        }
      />
      {boards.isPending ? (
        <Skeleton className="h-40" />
      ) : !boards.data ? (
        <ErrorState title="Could not load boards." error={boards.error} onRetry={() => void boards.refetch()} retrying={boards.isFetching} />
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {boards.data.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => setEditing(b)} className="flex w-full items-center gap-4 rounded-card border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-raised">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">
                    {b.name} <span className="font-mono text-[11.5px] font-normal text-ink-faint">/b/{b.slug}</span>
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-ink-muted">{b.repoUrl ?? "No repository yet"}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New board" : "Board settings"} width={600}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, slug: editing === "new" && !slugTyped ? slugify(e.target.value) : draft.slug })} />
            </Field>
            <Field label="Slug" hint="Used in the URL.">
              <Input
                required
                value={draft.slug}
                onChange={(e) => {
                  // Clearing the field hands it back to the name.
                  setSlugTyped(e.target.value !== "");
                  setDraft({ ...draft, slug: slugDraft(e.target.value) });
                }}
                onBlur={() => setDraft((d) => ({ ...d, slug: slugify(d.slug) }))}
                pattern="[a-z0-9][a-z0-9\-]*"
              />
            </Field>
          </div>
          <Field label="Repository URL" hint="GitHub only. Optional, but it is how an agent working in the repository finds this board.">
            <Input type="url" value={draft.repoUrl} onChange={(e) => setDraft({ ...draft, repoUrl: e.target.value })} placeholder="https://github.com/org/repo" />
          </Field>
          {save.isError ? <p className="text-[13px] text-danger">{save.error.message}</p> : null}
          <div className="flex items-center gap-2 pt-1">
            {editing && editing !== "new" ? (
              <Button type="button" variant="ghost" className="-ml-2 text-danger hover:bg-danger/10 hover:text-danger" icon={<Trash2 className="size-4" strokeWidth={1.75} />} onClick={() => setDeleting(editing)}>
                Delete board
              </Button>
            ) : null}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={save.isPending}>
                {editing === "new" ? "Create board" : "Save changes"}
              </Button>
            </div>
          </div>
        </form>
      </Dialog>
      <DeleteBoardDialog
        board={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          setEditing(null);
        }}
      />
    </>
  );
}

// Deleting names the Board twice: once by opening this from its settings, once by typing its slug.
function DeleteBoardDialog({ board, onClose, onDeleted }: { board: Board | null; onClose: () => void; onDeleted: () => void }) {
  // The last Board shown stays through the closing animation, so the dialog does not empty as it
  // fades; each opening starts the form afresh.
  const [shown, setShown] = useState(board);
  const [opening, setOpening] = useState(0);
  useEffect(() => {
    if (!board) return;
    setShown(board);
    setOpening((n) => n + 1);
  }, [board]);
  return (
    <Dialog open={board !== null} onClose={onClose} title="Delete board" width={480}>
      {shown ? <DeleteBoardForm key={opening} board={shown} onClose={onClose} onDeleted={onDeleted} /> : null}
    </Dialog>
  );
}

function DeleteBoardForm({ board, onClose, onDeleted }: { board: Board; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const impact = useQuery({
    queryKey: ["admin", "board-deletion", board.id],
    queryFn: () => request<BoardDeletionImpact>(`/admin/boards/${board.id}/deletion`),
    // Asked again at every opening: cards may have come or gone since.
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => request(`/admin/boards/${board.id}`, { method: "DELETE", body: JSON.stringify({ slug: typed.trim() }) }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: keys.board(board.slug) });
      for (const key of [keys.adminBoards, keys.boards, keys.adminBackups]) void qc.invalidateQueries({ queryKey: key });
      toast(`Deleted ${board.name}.`);
      onDeleted();
    },
  });
  const ready = canDelete(impact.data, typed, board.slug);
  const contents = impact.data ? deletionContents(impact.data) : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) remove.mutate();
      }}
    >
      {impact.isPending ? (
        <Skeleton className="h-16" />
      ) : !impact.data ? (
        <ErrorState title="Could not check what this board holds." error={impact.error} onRetry={() => void impact.refetch()} retrying={impact.isFetching} />
      ) : (
        <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-ink-muted">
          <p>
            <span className="font-medium text-ink">{board.name}</span>{" "}
            {contents ? <>will be deleted with everything on it: {contents}, and its activity.</> : <>has no cards yet. Its settings will be deleted.</>}
          </p>
          <p>A snapshot is taken first, so it can be restored from Backups. The repository on GitHub is not touched.</p>
        </div>
      )}
      <Field
        label={
          <>
            Type <span className="font-mono text-ink">{board.slug}</span> to confirm
          </>
        }
      >
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" className="font-mono text-[13px]" />
      </Field>
      {remove.isError ? <p className="text-[13px] text-danger">{remove.error.message}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" icon={<Trash2 className="size-4" strokeWidth={1.75} />} loading={remove.isPending} disabled={!ready}>
          Delete board
        </Button>
      </div>
    </form>
  );
}
