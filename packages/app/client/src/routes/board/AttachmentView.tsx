import { useRef, useState } from "react";
import { AlertCircle, FileText, ImageOff, Loader2 } from "lucide-react";
import type { Attachment } from "@kardboard/shared";
import { cx } from "../../components/ui";
import { useAttachmentDownload, useAttachmentUrl, useNearViewport } from "../../lib/attachments";
import { fileSize } from "../../lib/format";

const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-bg px-2.5 text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink";

export function AttachmentView({ a }: { a: Attachment }) {
  return a.mime.startsWith("image/") ? <AttachmentImage a={a} /> : <AttachmentFile a={a} />;
}

function AttachmentImage({ a }: { a: Attachment }) {
  const placeholder = useRef<HTMLDivElement>(null);
  const near = useNearViewport(placeholder);
  const load = useAttachmentUrl(a.id, near);
  const [painted, setPainted] = useState(false);

  if (load.status === "error") {
    return (
      <button type="button" onClick={load.retry} className={chip} title={load.error instanceof Error ? load.error.message : undefined}>
        <ImageOff className="size-3.5 text-danger" strokeWidth={1.75} />
        <span className="max-w-56 truncate">{a.filename}</span>
        <span className="text-[11px] text-ink-faint">Could not load. Retry</span>
      </button>
    );
  }
  if (load.status !== "ready") {
    return <div ref={placeholder} role="img" aria-label={`${a.filename}, loading`} className="h-32 w-48 animate-pulse rounded-control border border-line bg-raised" />;
  }
  return (
    <a href={load.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-control border border-line bg-raised">
      <img
        src={load.url}
        alt={a.filename}
        onLoad={() => setPainted(true)}
        className={cx("max-h-64 w-auto transition-opacity duration-200 ease-out-expo", painted ? "opacity-100" : "opacity-0")}
      />
    </a>
  );
}

function AttachmentFile({ a }: { a: Attachment }) {
  const { busy, error, download } = useAttachmentDownload(a.id, a.filename);
  return (
    <button type="button" onClick={() => void download()} className={chip} title={error instanceof Error ? error.message : `Download ${a.filename}`} aria-busy={busy}>
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
      ) : error ? (
        <AlertCircle className="size-3.5 text-danger" strokeWidth={1.75} />
      ) : (
        <FileText className="size-3.5" strokeWidth={1.75} />
      )}
      <span className="max-w-56 truncate">{a.filename}</span>
      {error ? <span className="text-[11px] text-danger">Retry</span> : <span className="font-mono text-[10.5px] text-ink-faint">{fileSize(a.size)}</span>}
      <span className="sr-only" aria-live="polite">
        {error ? "Download failed." : ""}
      </span>
    </button>
  );
}
