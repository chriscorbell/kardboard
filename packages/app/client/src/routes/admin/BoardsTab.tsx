import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { Board } from "@kardboard/shared";
import { keys, request, useAdminBoards, useAdminUsers, type AdminBoard } from "../../lib/api";
import { Avatar, Button, Chip, cx, ErrorState, Field, Input, Select, Skeleton, Textarea } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { TabHeader } from "./AdminPage";
import { slugDraft, slugify } from "./slug";

type Draft = {
  name: string;
  slug: string;
  repoUrl: string;
  provider: "claude" | "codex";
  model: string;
  reasoning: "" | "low" | "medium" | "high" | "max";
  previewMode: "external" | "runner";
  agentImage: string;
  maxConcurrentSessions: number;
  promptAppend: string;
  memberIds: string[];
};

const empty: Draft = { name: "", slug: "", repoUrl: "", provider: "claude", model: "", reasoning: "", previewMode: "external", agentImage: "", maxConcurrentSessions: 3, promptAppend: "", memberIds: [] };

function fromBoard(b: AdminBoard): Draft {
  return { name: b.name, slug: b.slug, repoUrl: b.repoUrl ?? "", provider: b.provider, model: b.model ?? "", reasoning: b.reasoning ?? "", previewMode: b.previewMode, agentImage: b.agentImage ?? "", maxConcurrentSessions: b.maxConcurrentSessions, promptAppend: b.promptAppend, memberIds: b.memberIds };
}

export function BoardsTab() {
  const boards = useAdminBoards();
  const users = useAdminUsers();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AdminBoard | "new" | null>(null);
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
        provider: draft.provider,
        model: draft.model.trim() || null,
        reasoning: draft.reasoning || null,
        previewMode: draft.previewMode,
        agentImage: draft.agentImage || null,
        maxConcurrentSessions: draft.maxConcurrentSessions,
        promptAppend: draft.promptAppend,
      };
      const board = editing === "new" ? await request<Board>("/admin/boards", { method: "POST", body: JSON.stringify(body) }) : await request<Board>(`/admin/boards/${(editing as AdminBoard).id}`, { method: "PATCH", body: JSON.stringify(body) });
      await request(`/admin/boards/${board.id}/members`, { method: "PUT", body: JSON.stringify({ userIds: draft.memberIds }) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.adminBoards });
      void qc.invalidateQueries({ queryKey: keys.boards });
      setEditing(null);
    },
  });

  const members = (users.data ?? []).filter((u) => u.role !== "admin" && u.status !== "revoked");

  return (
    <>
      <TabHeader
        title="Boards"
        body="One board per project. Each board holds its repository, provider, and the members who may open it."
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
        <ul className="grid gap-2">
          {boards.data.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => setEditing(b)} className="flex w-full items-center gap-4 rounded-card border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-raised">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">
                    {b.name} <span className="font-mono text-[11.5px] font-normal text-ink-faint">/b/{b.slug}</span>
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-ink-muted">{b.repoUrl ?? "No repository yet"}</p>
                </div>
                <Chip>{b.provider === "claude" ? "Claude Code" : "Codex"}</Chip>
                <Chip>{b.previewMode} preview</Chip>
                <span className="flex -space-x-1.5">
                  {b.memberIds.slice(0, 4).map((id) => {
                    const u = users.data?.find((x) => x.id === id);
                    return u ? <Avatar key={id} name={u.name} url={u.avatarUrl} size={22} className="ring-2 ring-surface" /> : null;
                  })}
                </span>
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
          <div className="grid grid-cols-2 gap-3">
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
          <Field label="Repository URL" hint="GitHub only. Both kardboard GitHub Apps must be installed on it.">
            <Input type="url" value={draft.repoUrl} onChange={(e) => setDraft({ ...draft, repoUrl: e.target.value })} placeholder="https://github.com/org/repo" />
          </Field>
          {editing !== "new" && editing ? <GitHubStatus boardId={editing.id} /> : null}
          <div className="grid grid-cols-3 gap-3">
            <Field label="Provider">
              <Select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as Draft["provider"] })}>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </Select>
            </Field>
            <Field label="Preview mode">
              <Select value={draft.previewMode} onChange={(e) => setDraft({ ...draft, previewMode: e.target.value as Draft["previewMode"] })}>
                <option value="external">External (project CI)</option>
                <option value="runner">Runner (Dockerfile)</option>
              </Select>
            </Field>
            <Field label="Max sessions">
              <Input type="number" min={1} max={10} value={draft.maxConcurrentSessions} onChange={(e) => setDraft({ ...draft, maxConcurrentSessions: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model" hint={draft.provider === "claude" ? "Claude Code --model. Empty uses its default. Examples: opus, sonnet." : "Codex -m. Empty uses its default. Example: gpt-5.5."}>
              <Input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="provider default" className="font-mono text-[13px]" />
            </Field>
            <Field label="Reasoning" hint={draft.provider === "claude" ? "Claude Code effort level." : "Codex reasoning effort; max means xhigh."}>
              <Select value={draft.reasoning} onChange={(e) => setDraft({ ...draft, reasoning: e.target.value as Draft["reasoning"] })}>
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="max">Max</option>
              </Select>
            </Field>
          </div>
          <Field label="Agent image override" hint="Leave empty for the default image.">
            <Input value={draft.agentImage} onChange={(e) => setDraft({ ...draft, agentImage: e.target.value })} placeholder="ghcr.io/org/image:tag" className="font-mono text-[13px]" />
          </Field>
          <Field label="Extra instructions for the agent" hint="Appended to the global workflow prompt for this board only.">
            <Textarea rows={3} value={draft.promptAppend} onChange={(e) => setDraft({ ...draft, promptAppend: e.target.value })} />
          </Field>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink-muted">Members</p>
            {members.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">Invite users first. Admins always have access.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {members.map((u) => {
                  const on = draft.memberIds.includes(u.id);
                  return (
                    <li key={u.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setDraft({ ...draft, memberIds: on ? draft.memberIds.filter((id) => id !== u.id) : [...draft.memberIds, u.id] })}
                        className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-3 text-[13px] transition-colors", on ? "border-accent/40 bg-accent-soft text-ink" : "border-line bg-surface text-ink-muted hover:border-line-strong")}
                      >
                        <Avatar name={u.name} url={u.avatarUrl} size={22} />
                        {u.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {save.isError ? <p className="text-[13px] text-danger">{save.error.message}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {editing === "new" ? "Create board" : "Save changes"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function GitHubStatus({ boardId }: { boardId: string }) {
  const q = useQuery({ queryKey: ["admin", "board-github", boardId], queryFn: () => request<{ repo: string | null; sessions: string; merge: string }>(`/admin/boards/${boardId}/github`) });
  if (!q.data || !q.data.repo) return null;
  const tone = (s: string) => (s === "installed" ? "ok" : s === "missing" ? "danger" : "neutral") as "ok" | "danger" | "neutral";
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
      <span>GitHub Apps on {q.data.repo}:</span>
      <Chip tone={tone(q.data.sessions)}>sessions {q.data.sessions}</Chip>
      <Chip tone={tone(q.data.merge)}>merge {q.data.merge}</Chip>
    </div>
  );
}
