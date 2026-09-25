import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, X } from "lucide-react";
import type { Attachment } from "@kardboard/shared";
import { cx, IconButton } from "../../components/ui";
import { isInnermostModal, useModalFocus } from "../../components/focus";
import { useAttachmentDownload, useAttachmentUrl } from "../../lib/attachments";

// A Comment's images, one at a time over the page. The image fits the screen; one larger than that
// opens to its own size with a click, to read a screenshot. Arrows move between the Comment's
// images, Escape closes, and so does a click beside the image.
export function ImageViewer({ images, index, onIndex, onClose }: { images: Attachment[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const reduce = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const open = index !== null;
  useModalFocus(panel, open, { initial: "container" });

  useEffect(() => {
    if (index === null) return;
    // Captured and stopped on the document, as the Dialog does, so the card sheet under the viewer
    // does not close on the same Escape.
    const onKey = (e: KeyboardEvent) => {
      if (!isInnermostModal(panel)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, images.length, onIndex, onClose]);

  const image = index === null ? null : images[index];
  return createPortal(
    <AnimatePresence>
      {image && index !== null ? (
        <motion.div
          ref={panel}
          key="viewer"
          role="dialog"
          aria-modal="true"
          aria-label={image.filename}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="fixed inset-0 z-[60] flex flex-col bg-[rgba(12,11,10,0.94)] backdrop-blur-sm focus:outline-none"
        >
          <Shown key={image.id} image={image} index={index} count={images.length} onIndex={onIndex} onClose={onClose} />
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function Shown({ image, index, count, onIndex, onClose }: { image: Attachment; index: number; count: number; onIndex: (i: number) => void; onClose: () => void }) {
  const reduce = useReducedMotion();
  // Served private and cached for an hour, so this is the thumbnail's own download again, not another.
  const load = useAttachmentUrl(image.id, true);
  const { busy, download } = useAttachmentDownload(image.id, image.filename);
  const img = useRef<HTMLImageElement>(null);
  const [zoomable, setZoomable] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  // Whether the picture was scaled down to fit, and so has more to show at its own size.
  const measure = () => {
    const el = img.current;
    if (el && !zoomed) setZoomable(el.naturalWidth > el.clientWidth + 1 || el.naturalHeight > el.clientHeight + 1);
  };
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [zoomed]);

  const closeOnBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 px-4 py-3">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink">{image.filename}</p>
        {count > 1 ? (
          <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">
            {index + 1} / {count}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton label={`Download ${image.filename}`} onClick={() => void download()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Download className="size-4" strokeWidth={1.75} />}
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      </header>
      <div onClick={closeOnBackdrop} className={cx("relative min-h-0 flex-1", zoomed ? "overflow-auto" : "flex items-center justify-center overflow-hidden px-4 pb-6 sm:px-16")}>
        {load.status === "ready" ? (
          <motion.img
            ref={img}
            src={load.url}
            alt={image.filename}
            draggable={false}
            onLoad={measure}
            onClick={() => zoomable && setZoomed((z) => !z)}
            initial={reduce ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={cx(
              "select-none rounded-control shadow-[0_24px_64px_-16px_rgba(0,0,0,0.8)]",
              zoomed ? "m-auto block max-w-none cursor-zoom-out" : "max-h-full max-w-full object-contain",
              !zoomed && zoomable && "cursor-zoom-in",
            )}
          />
        ) : load.status === "error" ? (
          <button type="button" onClick={load.retry} className="inline-flex items-center gap-2 text-[13px] text-ink-muted hover:text-ink">
            <ImageOff className="size-4 text-danger" strokeWidth={1.75} />
            Could not load the image. Retry
          </button>
        ) : (
          <Loader2 className="size-5 animate-spin text-ink-faint" strokeWidth={1.75} aria-label="Loading" />
        )}
        {index > 0 ? <Step side="left" onClick={() => onIndex(index - 1)} /> : null}
        {index < count - 1 ? <Step side="right" onClick={() => onIndex(index + 1)} /> : null}
      </div>
    </>
  );
}

function Step({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={onClick}
      className={cx(
        "fixed top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-raised/80 text-ink-muted backdrop-blur transition-colors hover:bg-overlay hover:text-ink",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      <Icon className="size-5" strokeWidth={1.75} />
    </button>
  );
}
