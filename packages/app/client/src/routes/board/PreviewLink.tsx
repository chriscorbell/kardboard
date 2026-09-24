import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, AlertTriangle, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import type { Card } from "@kardboard/shared";
import { cx } from "../../components/ui";
import { previewDisplay } from "./previewState";

const EASE = [0.16, 1, 0.3, 1] as const;
const linkClass = "inline-flex items-center gap-1.5 no-underline transition-colors hover:text-accent";

// The Preview item in the card sheet's work-links row. Besides the link it says what a person should
// know before trusting what they see: that a build is still running, that it failed and why, that a
// rebuild was lost and it still shows the previous build, or that it shows an older commit than the
// one Approve would merge. Rendered as items of that flex row, so
// a failed build's error can open across the row's full width beneath it.
export function PreviewLink({ card }: { card: Card }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const errorId = useId();
  const shown = previewDisplay(card);
  if (!shown || !card.previewUrl) return null;
  const appear = { initial: reduce ? false : { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, ease: EASE } } as const;

  if (shown.kind === "failed") {
    return (
      <>
        <motion.span key="failed" {...appear} className="inline-flex">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={errorId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 rounded-[4px] text-danger transition-colors hover:text-ink"
          >
            <AlertCircle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            Preview failed
            <ChevronDown className={cx("size-3 transition-transform duration-200", open && "rotate-180")} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </motion.span>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="preview-error"
              id={errorId}
              initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="basis-full overflow-hidden"
            >
              {shown.note ? <p className="mb-1.5 text-[12px] text-ink-muted">{shown.note}</p> : null}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-muted">{shown.error}</pre>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </>
    );
  }

  if (shown.kind === "building") {
    return (
      <motion.a key="building" {...appear} href={card.previewUrl} target="_blank" rel="noreferrer" title={shown.note} className={cx(linkClass, "text-ink-muted")}>
        <Loader2 className="size-3.5 motion-safe:animate-spin" strokeWidth={1.75} aria-hidden="true" />
        {shown.rebuilding ? "Preview rebuilding" : "Preview building"}
      </motion.a>
    );
  }

  return (
    <motion.span key="link" {...appear} className="inline-flex items-center gap-2.5">
      <a href={card.previewUrl} target="_blank" rel="noreferrer" title={shown.note ?? undefined} className={cx(linkClass, "text-ink")}>
        <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        Open preview
      </a>
      {shown.warning ? (
        <span className="inline-flex items-center gap-1 text-warn" title={shown.note ?? undefined}>
          <AlertTriangle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          {shown.warning}
          <span className="sr-only">: {shown.note}</span>
        </span>
      ) : null}
    </motion.span>
  );
}
