import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Paperclip, Upload } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, PRIORITIES, type Card, type Column, type Priority } from "@kardboard/shared";
import { Dialog } from "../../components/Dialog";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import { commentRequests, useCreateCard } from "../../lib/api";
import { postComment, UploadFailed, type PostProgress } from "../../lib/commentPost";
import { filesFromPaste, useFileDrop } from "../../lib/fileInput";
import { partitionBySize, tooLargeMessage } from "../../lib/files";
import { useCoarsePointer } from "../../lib/pointer";
import { attachmentOnlyBody, FileChips } from "./Composer";

const PRIORITY_LABELS: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High" };

// Files picked here go up after the Card exists, on one Comment by its creator. That Comment is
// written within moments of the Card, so its Trigger joins the Card's own in the same coalesced
// dispatch and the Session sees the request and its files together.
type Upload = { card: Card; progress: PostProgress<File> | null; fractions: ReadonlyMap<File, number>; error: string | null };

export function NewCardDialog({ slug, open, onClose, isAdmin, onCreated }: { slug: string; open: boolean; onClose: () => void; isAdmin: boolean; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [column, setColumn] = useState<Column>("inbox");
  const [silent, setSilent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the Card exists and files are going up. A failed upload keeps it, so trying again
  // finishes the same Comment instead of creating a second Card.
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploading, setUploading] = useState(false);
  const create = useCreateCard(slug);
  const touch = useCoarsePointer();
  const fileRef = useRef<HTMLInputElement>(null);
  // Set in the same tick as the request starts, where `isPending` would still read false for a
  // second Cmd+Enter or the form's own Enter submission.
  const submitting = useRef(false);
  // Which opening of the dialog an upload belongs to, so one still running after the dialog was
  // closed does not open its Card over whatever the person went on to do.
  const session = useRef(0);

  useEffect(() => {
    if (open) {
      session.current += 1;
      setTitle("");
      setDescription("");
      setPriority("none");
      setColumn("inbox");
      setSilent(false);
      setFiles([]);
      setNotice(null);
      setUpload(null);
      setUploading(false);
      create.reset();
    }
    // `create` is a new object each render; only reopening should clear it.
  }, [open]);

  const addFiles = (picked: File[]) => {
    if (upload || picked.length === 0) return;
    const { accepted, tooLarge } = partitionBySize(picked);
    setFiles((fs) => [...fs, ...accepted]);
    setNotice(tooLargeMessage(tooLarge.map((f) => f.name)));
  };
  const drop = useFileDrop(addFiles, open && !upload);

  const finish = (card: Card, at: number) => {
    if (session.current !== at) return;
    onClose();
    onCreated(card.id);
  };
  // Closing leaves whatever is still uploading to finish on its own, without opening the Card.
  const dismiss = () => {
    session.current += 1;
    onClose();
  };

  const sendFiles = async (state: Upload, at: number) => {
    setUploading(true);
    setUpload({ ...state, error: null });
    let progress = state.progress;
    const requests = commentRequests(state.card.id, {
      silent: silent || undefined,
      onProgress: (file, fraction) => setUpload((u) => u && { ...u, fractions: new Map(u.fractions).set(file, fraction) }),
    });
    try {
      await postComment(requests, attachmentOnlyBody(files.length), files, progress, (p) => {
        progress = p;
        setUpload((u) => u && { ...u, progress: p });
      });
      setUploading(false);
      finish(state.card, at);
    } catch (err) {
      if (session.current !== at) return;
      const which = err instanceof UploadFailed ? `${(err.file as File).name} did not upload.` : "The files did not upload.";
      setUpload((u) => u && { ...u, progress, error: `The card is created, but ${which} ${(err as Error).message}` });
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!title.trim() || submitting.current) return;
    const at = session.current;
    submitting.current = true;
    try {
      if (upload) return await sendFiles(upload, at);
      const card = await create.mutateAsync({ title, description, priority, column, silent: silent || undefined });
      if (files.length === 0) return finish(card, at);
      await sendFiles({ card, progress: null, fractions: new Map(), error: null }, at);
    } catch {
      // Shown below the form from the mutation's error.
    } finally {
      submitting.current = false;
    }
  };

  const locked = Boolean(upload);
  const busy = create.isPending || uploading;

  return (
    <Dialog open={open} onClose={dismiss} title="New card">
      <form
        className="relative flex flex-col gap-4"
        {...drop.handlers}
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
        onPaste={(e) => {
          if (locked) return;
          const pasted = filesFromPaste(e);
          if (!pasted) return;
          e.preventDefault();
          addFiles(pasted);
        }}
      >
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to change?" maxLength={200} disabled={locked} />
        </Field>
        <Field label="Details" hint="Markdown works. Steps to reproduce, links, and what done looks like all help.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} placeholder="" disabled={locked} />
        </Field>
        <div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" className="-ml-2.5" icon={<Paperclip className="size-3.5" strokeWidth={1.75} />} onClick={() => fileRef.current?.click()} disabled={locked}>
              Attach files
            </Button>
            {touch ? null : <span className="text-[12px] text-ink-faint">or paste or drop them here</span>}
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {files.length > 0 ? <FileChips files={files} progress={upload ? upload.fractions : null} onRemove={locked ? undefined : (i) => setFiles((fs) => fs.filter((_, j) => j !== i))} /> : null}
          {notice ? (
            <p role="status" className="mt-2 text-[12px] text-warn">
              {notice}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} disabled={locked}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          {isAdmin ? (
            <Field label="Column">
              <Select value={column} onChange={(e) => setColumn(e.target.value as Column)} disabled={locked}>
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
            <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} className="accent-accent" disabled={locked} />
            Silent: don't start a session for this card yet
          </label>
        ) : null}
        {create.isError ? (
          <p role="alert" className="text-[13px] text-danger">
            Could not create the card. {create.error.message}
          </p>
        ) : null}
        {upload?.error ? (
          <p role="alert" className="text-[13px] text-danger">
            {upload.error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          {upload?.error ? (
            <Button type="button" variant="ghost" onClick={() => finish(upload.card, session.current)}>
              Open the card
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={dismiss}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>
            {uploading ? "Uploading" : upload?.error ? "Try again" : "Create card"}
          </Button>
        </div>
        <AnimatePresence>
          {drop.over ? (
            <motion.div
              key="drop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="pointer-events-none absolute -inset-2 flex items-center justify-center rounded-card border border-dashed border-accent/60 bg-raised/90 text-[13px] font-medium text-accent"
            >
              <Upload className="mr-2 size-4" strokeWidth={1.75} />
              Drop to attach
            </motion.div>
          ) : null}
        </AnimatePresence>
      </form>
    </Dialog>
  );
}
