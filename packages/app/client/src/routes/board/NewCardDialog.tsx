import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { COLUMNS, COLUMN_LABELS, PRIORITIES, type Column, type Priority } from "@kardboard/shared";
import { Dialog } from "../../components/Dialog";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import { useCreateCard } from "../../lib/api";

const PRIORITY_LABELS: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High" };

export function NewCardDialog({ slug, open, onClose, isAdmin }: { slug: string; open: boolean; onClose: () => void; isAdmin: boolean }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [column, setColumn] = useState<Column>("inbox");
  const [silent, setSilent] = useState(false);
  const create = useCreateCard(slug);
  const navigate = useNavigate();
  // Set in the same tick as the request starts, where `isPending` would still read false for a
  // second Cmd+Enter or the form's own Enter submission.
  const submitting = useRef(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setPriority("none");
      setColumn("inbox");
      setSilent(false);
      create.reset();
    }
    // `create` is a new object each render; only reopening should clear it.
  }, [open]);

  const submit = async () => {
    if (!title.trim() || submitting.current) return;
    submitting.current = true;
    try {
      const card = await create.mutateAsync({ title, description, priority, column, silent: silent || undefined });
      onClose();
      navigate(`/b/${slug}/c/${card.id}`);
    } catch {
      // Shown below the form from the mutation's error.
    } finally {
      submitting.current = false;
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New card">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to change?" maxLength={200} />
        </Field>
        <Field label="Details" hint="Markdown works. Steps to reproduce, links, and what done looks like all help.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} placeholder="" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          {isAdmin ? (
            <Field label="Column">
              <Select value={column} onChange={(e) => setColumn(e.target.value as Column)}>
                {COLUMNS.map((c) => (
                  <option key={c} value={c}>
                    {COLUMN_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        {isAdmin ? (
          <label className="flex items-center gap-2 text-[13px] text-ink-muted">
            <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} className="accent-accent" />
            Silent: don't start a session for this card yet
          </label>
        ) : null}
        {create.isError ? (
          <p role="alert" className="text-[13px] text-danger">
            Could not create the card. {create.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!title.trim()}>
            Create card
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
