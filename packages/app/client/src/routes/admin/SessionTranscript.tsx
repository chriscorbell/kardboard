import { useEffect, useRef, useState } from "react";
import { Wrench, CornerDownRight } from "lucide-react";
import type { TranscriptEntry } from "@kardboard/shared";
import { fetchSessionTranscript } from "../../lib/api";
import { Skeleton, cx } from "../../components/ui";
import { clockTime } from "../../lib/format";

// A running session writes a line every few seconds, so polling reads well and costs one small
// request per tick: each one asks only for the bytes written since the last.
const POLL_MS = 2_500;

export function SessionTranscript({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let stopped = false;
    let offset = 0;
    setEntries([]);
    setLoading(true);
    setNote(null);
    setError(null);
    pinned.current = true;

    const tick = async () => {
      try {
        const view = await fetchSessionTranscript(sessionId, offset);
        if (stopped) return;
        offset = view.nextOffset;
        setNote(view.note);
        setError(null);
        if (view.entries.length > 0) setEntries((prev) => [...prev, ...view.entries]);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    void tick();
    const timer = live ? setInterval(() => void tick(), POLL_MS) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, live]);

  // Follow the tail, but stop following the moment the reader scrolls up to read something.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="mt-2 rounded-card border border-line bg-bg">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-96 overflow-y-auto px-3 py-2"
      >
        {loading && entries.length === 0 ? (
          <Skeleton className="h-16" />
        ) : entries.length === 0 ? (
          <p className="py-4 text-center text-[12.5px] text-ink-faint">{note ?? "Nothing in the transcript yet."}</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {entries.map((entry, i) => (
              <Line key={`${i}-${entry.at ?? ""}`} entry={entry} />
            ))}
          </ol>
        )}
      </div>
      {error ? <p className="border-t border-line px-3 py-1.5 text-[12px] text-danger">Could not read the transcript: {error}</p> : null}
      {!error && live ? <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-faint">Following live. Tool input and output are shown as the agent sent them.</p> : null}
    </div>
  );
}

function Line({ entry }: { entry: TranscriptEntry }) {
  const body = entry.truncated ? `${entry.body}…` : entry.body;
  const stamp = entry.at ? (
    <span className="mt-[3px] w-14 shrink-0 select-none font-mono text-[10.5px] text-ink-faint">{clockTime(entry.at)}</span>
  ) : (
    <span className="w-14 shrink-0" />
  );

  if (entry.kind === "tool") {
    return (
      <li className="flex gap-2">
        {stamp}
        <span className="flex min-w-0 items-start gap-1.5 text-[12.5px]">
          <Wrench className="mt-[3px] size-3 shrink-0 text-accent" strokeWidth={2} />
          <span className="font-mono text-accent">{entry.label}</span>
          <span className="min-w-0 break-all font-mono text-[12px] text-ink-muted">{body}</span>
        </span>
      </li>
    );
  }

  if (entry.kind === "tool_result") {
    return (
      <li className="flex gap-2">
        {stamp}
        <span className="flex min-w-0 items-start gap-1.5">
          <CornerDownRight className="mt-[3px] size-3 shrink-0 text-ink-faint" strokeWidth={2} />
          <pre className={cx("min-w-0 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11.5px]", entry.isError ? "text-danger" : "text-ink-faint")}>{body}</pre>
        </span>
      </li>
    );
  }

  const tone = {
    text: "text-ink",
    thinking: "text-ink-muted italic",
    system: "text-ink-faint",
    result: entry.isError ? "text-danger" : "text-ok",
    log: "font-mono text-[11.5px] text-ink-faint",
    tool: "",
    tool_result: "",
  }[entry.kind];

  return (
    <li className="flex gap-2">
      {stamp}
      <div className="min-w-0 flex-1">
        {entry.label ? <span className="mr-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">{entry.label}</span> : null}
        <span className={cx("whitespace-pre-wrap break-words text-[12.5px]", tone)}>{body}</span>
      </div>
    </li>
  );
}
