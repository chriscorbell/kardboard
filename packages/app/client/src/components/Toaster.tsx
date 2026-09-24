import { useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, X } from "lucide-react";
import { currentToasts, dismissToast, subscribeToasts } from "../lib/toast";

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts, currentToasts);
  const reduce = useReducedMotion();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout={!reduce}
            initial={reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-card border border-line-strong bg-raised py-2.5 pl-3 pr-1.5 text-[13px] text-ink shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
            <p className="min-w-0 flex-1 leading-snug">{t.message}</p>
            <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="-my-0.5 rounded-control p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-ink">
              <X className="size-3.5" strokeWidth={2} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
