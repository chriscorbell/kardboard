import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Paperclip, Send, X } from "lucide-react";
import type { AgentProfile, Person } from "@kardboard/shared";
import { Avatar, Button, cx, IconButton, Textarea } from "../../components/ui";
import type { UploadProgress } from "../../lib/api";
import { filesFromPaste } from "../../lib/fileInput";
import { partitionBySize, tooLargeMessage } from "../../lib/files";
import { fileSize } from "../../lib/format";
import { useCoarsePointer } from "../../lib/pointer";
import { composerKeyAction } from "./composerKeys";
import { mentionCandidates } from "./mentionCandidates";

type Props = {
  /** Who the @ list offers: people who can open the Board now. */
  members: Person[];
  agent: AgentProfile;
  onSubmit: (body: string, files: File[], onProgress: UploadProgress) => Promise<void>;
  initialBody?: string;
  submitLabel?: string;
  onCancel?: () => void;
  allowFiles?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
};

// What the card sheet can do to the composer from outside it: bring it into view for a reply, and
// hand it files dropped anywhere on the sheet.
export type ComposerHandle = { focus: () => void; addFiles: (files: File[]) => void };

// Files alone make a Comment too; the server needs words, so these stand in for them.
export function attachmentOnlyBody(count: number): string {
  return count === 1 ? "Attached a file." : "Attached files.";
}

// A textarea with @mention completion. Typing "@" opens a list of Board members filtered by what follows.
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { members, agent, onSubmit, initialBody = "", submitLabel = "Post", onCancel, allowFiles = true, autoFocus, placeholder },
  handle,
) {
  const [body, setBody] = useState(initialBody);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<ReadonlyMap<File, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Something left out of the last pick, paste, or drop, said once rather than dropped silently.
  const [notice, setNotice] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const touch = useCoarsePointer();
  const reduce = useReducedMotion();

  const candidates = useMemo(() => (mention ? mentionCandidates(agent, members, mention.query) : []), [members, mention, agent]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const addFiles = (picked: File[]) => {
    if (!allowFiles || picked.length === 0) return;
    const { accepted, tooLarge } = partitionBySize(picked);
    setFiles((fs) => [...fs, ...accepted]);
    setNotice(tooLargeMessage(tooLarge.map((f) => f.name)));
  };

  useImperativeHandle(handle, () => ({
    focus: () => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    },
    addFiles: (picked) => {
      addFiles(picked);
      ref.current?.focus({ preventScroll: true });
    },
  }));

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(before);
    if (m) {
      setMention({ start: caret - m[2]!.length - 1, query: m[2]! });
      setHighlight(0);
    } else setMention(null);
  };

  const pick = (handle: string) => {
    if (!mention) return;
    const caret = ref.current?.selectionStart ?? body.length;
    const next = `${body.slice(0, mention.start)}@${handle} ${body.slice(caret)}`;
    setBody(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + handle.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const canPost = Boolean(body.trim()) || files.length > 0;

  const submit = async () => {
    if (!canPost || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    // What goes out now. The box stays usable while a long upload runs, so what is typed, pasted, or
    // dropped meanwhile is kept for the next post rather than cleared with this one.
    const sentBody = body;
    const sentFiles = files;
    try {
      await onSubmit(sentBody.trim() || attachmentOnlyBody(sentFiles.length), sentFiles, (file, fraction) => setProgress((p) => new Map(p).set(file, fraction)));
      setBody((b) => (b === sentBody ? "" : b));
      setFiles((fs) => fs.filter((f) => !sentFiles.includes(f)));
      setProgress((p) => new Map([...p].filter(([f]) => !sentFiles.includes(f))));
    } catch (err) {
      setError((err as Error).message || "Could not post.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={body}
        rows={3}
        placeholder={placeholder ?? "Write a comment. Use @ to mention someone."}
        onChange={(e) => {
          setBody(e.target.value);
          detectMention(e.target.value, e.target.selectionStart);
        }}
        onPaste={(e) => {
          if (!allowFiles) return;
          const pasted = filesFromPaste(e);
          if (!pasted) return;
          e.preventDefault();
          addFiles(pasted);
        }}
        onKeyDown={(e) => {
          const handled = composerKeyAction(
            { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            { mentionOpen: mention !== null && candidates.length > 0, canCancel: Boolean(onCancel), touch },
          );
          if (!handled) return;
          if (handled.preventDefault) e.preventDefault();
          switch (handled.action.type) {
            case "mention-move": {
              const delta = handled.action.delta;
              setHighlight((h) => (h + delta + candidates.length) % candidates.length);
              return;
            }
            case "mention-pick":
              pick(candidates[highlight]!.handle);
              return;
            case "mention-close":
              setMention(null);
              return;
            case "submit":
              void submit();
              return;
            case "cancel":
              onCancel?.();
          }
        }}
        onBlur={() => setTimeout(() => setMention(null), 120)}
        className="pr-3"
      />
      {mention && candidates.length > 0 ? (
        <ul className="absolute left-2 z-20 mt-1 w-64 overflow-hidden rounded-card border border-line-strong bg-raised p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]" role="listbox">
          {candidates.map((c, i) => (
            <li key={c.handle}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c.handle);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cx("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px]", i === highlight ? "bg-overlay text-ink" : "text-ink-muted")}
              >
                <Avatar name={c.name} url={c.avatarUrl} size={20} tone={c.agent ? "agent" : "neutral"} />
                <span className="truncate">{c.name}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">@{c.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? <FileChips files={files} progress={busy ? progress : null} onRemove={busy ? undefined : (i) => setFiles((fs) => fs.filter((_, j) => j !== i))} /> : null}
      {notice ? (
        <p role="status" className="mt-2 text-[12px] text-warn">
          {notice}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <div className="mt-2 flex items-center gap-1">
        {allowFiles ? (
          <>
            <IconButton label="Attach files" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Paperclip className="size-4" strokeWidth={1.75} />
            </IconButton>
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
          </>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {touch ? null : <span className="hidden text-[11px] text-ink-faint sm:inline">Enter to {submitLabel.toLowerCase()}, Shift+Enter for a new line</span>}
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={busy} disabled={!canPost} icon={<Send className="size-3.5" strokeWidth={2} />}>
            {busy && files.length > 0 ? "Uploading" : submitLabel}
          </Button>
        </span>
      </div>
    </div>
  );
});

// The files waiting to go with a Comment. While they upload each one fills from the left as its
// bytes leave, so a large file on a slow connection is visibly moving rather than stuck.
export function FileChips({ files, progress, onRemove }: { files: File[]; progress: ReadonlyMap<File, number> | null; onRemove?: (index: number) => void }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f, i) => {
        const fraction = progress ? (progress.get(f) ?? 0) : null;
        return (
          <li
            key={`${f.name}-${f.size}-${i}`}
            className={cx("relative inline-flex h-6 items-center gap-1.5 overflow-hidden rounded-full border border-line bg-surface pl-2 text-[12px] text-ink-muted", onRemove ? "pr-1" : "pr-2")}
          >
            {fraction !== null ? (
              <span aria-hidden="true" className="absolute inset-0 origin-left bg-accent-soft transition-transform duration-200 ease-out-expo" style={{ transform: `scaleX(${fraction})` }} />
            ) : null}
            <span className="relative max-w-40 truncate">{f.name}</span>
            <span className="relative font-mono text-[10.5px] text-ink-faint">{fraction !== null ? `${Math.round(fraction * 100)}%` : fileSize(f.size)}</span>
            {onRemove ? (
              <button type="button" aria-label={`Remove ${f.name}`} className="relative rounded-full p-0.5 hover:bg-overlay" onClick={() => onRemove(i)}>
                <X className="size-3" strokeWidth={2} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
