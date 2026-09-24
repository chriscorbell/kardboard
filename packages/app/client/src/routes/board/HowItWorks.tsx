import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, type AgentProfile, type Column } from "@kardboard/shared";
import { Avatar, Button, Chip, IconButton } from "../../components/ui";
import { COLUMN_TONES } from "./columns";

function columnLine(column: Column, agent: string): string {
  switch (column) {
    case "inbox":
      return "New requests. Add one with New card.";
    case "blocked":
      return `${agent} has a question. Answer it in a comment.`;
    case "ready":
      return `Understood, and waiting for ${agent} to start.`;
    case "in_progress":
      return `${agent} is making the change.`;
    case "review":
      return "Ready to check. Open the preview, then approve.";
    case "done":
      return "Merged, closed, or a duplicate.";
  }
}

// The board explained in the few lines a new client needs: what each column means, that the Agent
// answers every change about a minute later, and that Approve is what merges. Shown once, until
// dismissed, and again from the toolbar's help button.
export function HowItWorks({ open, agent, onClose }: { open: boolean; agent: AgentProfile; onClose: () => void }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.section
          key="how-it-works"
          aria-labelledby="how-it-works-title"
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="shrink-0 overflow-hidden border-b border-line bg-surface"
        >
          <div className="max-h-[70dvh] overflow-y-auto px-4 py-4 sm:px-5">
            <div className="flex items-start gap-3">
              <Avatar name={agent.name} url={agent.avatarUrl} size={28} tone="agent" className="mt-0.5 max-sm:hidden" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="how-it-works-title" className="text-[14px] font-semibold text-ink">
                    How this board works
                  </h2>
                  <IconButton label="Close" className="-my-1 -mr-1.5 size-7 shrink-0" onClick={onClose}>
                    <X className="size-4" strokeWidth={1.75} />
                  </IconButton>
                </div>
                <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-muted">
                  Every change you make (a new card, an edit, a comment, or a move) reaches {agent.name} about a minute later. {agent.name} then does the work, or asks you a question on the card.
                </p>
                <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                  {COLUMNS.map((c) => (
                    <li key={c} className="flex items-baseline gap-2.5 text-[13px] text-ink-muted">
                      <Chip tone={COLUMN_TONES[c]} className="w-[5.75rem] shrink-0 justify-center sm:w-[6.5rem]">
                        {COLUMN_LABELS[c]}
                      </Chip>
                      <span className="min-w-0">{columnLine(c, agent.name)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-ink-muted">
                  <span className="text-ink">Approve merges the change.</span> If something is not right, say so in a comment instead.
                </p>
                <Button size="sm" variant="primary" className="mt-3" onClick={onClose}>
                  Got it
                </Button>
              </div>
            </div>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
