import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Paperclip, Send, X } from "lucide-react";
import type { AgentProfile, User } from "@kardboard/shared";
import { Avatar, Button, cx, IconButton, Textarea } from "../../components/ui";
import { composerKeyAction } from "./composerKeys";

type Props = {
  members: User[];
  agent: AgentProfile;
  onSubmit: (body: string, files: File[]) => Promise<void>;
  initialBody?: string;
  submitLabel?: string;
  onCancel?: () => void;
  allowFiles?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Lets the card sheet focus the composer, as Request changes does. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
};

// A textarea with @mention completion. Typing "@" opens a list of Board members filtered by what follows.
export function Composer({ members, agent, onSubmit, initialBody = "", submitLabel = "Post", onCancel, allowFiles = true, autoFocus, placeholder, inputRef }: Props) {
  const [body, setBody] = useState(initialBody);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo(() => {
    const all = [{ handle: agent.name.toLowerCase(), name: agent.name, avatarUrl: agent.avatarUrl, agent: true }, ...members.map((m) => ({ handle: m.handle, name: m.name, avatarUrl: m.avatarUrl, agent: false }))];
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return all.filter((c) => c.handle.startsWith(q) || c.name.toLowerCase().includes(q)).slice(0, 6);
  }, [members, mention, agent]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

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

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim(), files);
      setBody("");
      setFiles([]);
    } catch (err) {
      setError((err as Error).message || "Could not post.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <Textarea
        ref={(el) => {
          ref.current = el;
          if (inputRef) inputRef.current = el;
        }}
        value={body}
        rows={3}
        placeholder={placeholder ?? "Write a comment. Use @ to mention someone."}
        onChange={(e) => {
          setBody(e.target.value);
          detectMention(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          const handled = composerKeyAction(
            { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            { mentionOpen: mention !== null && candidates.length > 0, canCancel: Boolean(onCancel) },
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
      {files.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface pl-2 pr-1 text-[12px] text-ink-muted">
              <span className="max-w-40 truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} className="rounded-full p-0.5 hover:bg-overlay" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                <X className="size-3" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <div className="mt-2 flex items-center gap-1">
        {allowFiles ? (
          <>
            <IconButton label="Attach files" onClick={() => fileRef.current?.click()}>
              <Paperclip className="size-4" strokeWidth={1.75} />
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []).filter((f) => f.size <= 25 * 1024 * 1024);
                setFiles((fs) => [...fs, ...picked]);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-ink-faint sm:inline">Enter to {submitLabel.toLowerCase()}, Shift+Enter for a new line</span>
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={busy} disabled={!body.trim()} icon={<Send className="size-3.5" strokeWidth={2} />}>
            {submitLabel}
          </Button>
        </span>
      </div>
    </div>
  );
}
