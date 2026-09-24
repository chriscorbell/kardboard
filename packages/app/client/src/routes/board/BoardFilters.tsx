import { forwardRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Search, X } from "lucide-react";
import { PRIORITIES, type Priority } from "@kardboard/shared";
import { cx, Kbd } from "../../components/ui";
import { useCoarsePointer } from "../../lib/pointer";
import { filterActive, NO_FILTER, type BoardFilter } from "./boardFilter";

const PRIORITY_LABELS: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High" };

// The toolbar's search field. "/" anywhere on the board focuses it; Escape clears it, then leaves it.
export const BoardSearch = forwardRef<HTMLInputElement, { value: string; onChange: (q: string) => void; className?: string }>(function BoardSearch({ value, onChange, className }, ref) {
  const touch = useCoarsePointer();
  return (
    <div className={cx("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" strokeWidth={1.75} aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder="Search cards"
        aria-label="Search cards"
        aria-keyshortcuts="/"
        className="h-7 w-full rounded-control border border-line-strong bg-surface pl-8 pr-7 text-[13px] text-ink placeholder:text-ink-faint transition-colors duration-150 hover:border-[#4a463f] focus:border-accent focus:outline-none"
      />
      {value ? (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[6px] p-1 text-ink-faint transition-colors hover:bg-overlay hover:text-ink">
          <X className="size-3.5" strokeWidth={2} />
        </button>
      ) : touch ? null : (
        <span className="pointer-events-none absolute right-1.5 top-1/2 hidden -translate-y-1/2 sm:block" aria-hidden="true">
          <Kbd>/</Kbd>
        </span>
      )}
    </div>
  );
});

const chip = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors duration-150";
const chipOff = "border-line text-ink-muted hover:border-line-strong hover:text-ink";
const chipOn = "border-accent/40 bg-accent-soft text-accent";

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={cx(chip, pressed ? chipOn : chipOff)}>
      {children}
    </button>
  );
}

// Mine, Needs me, and Priority. Priority is a native select dressed as a chip: its list opens as the
// phone's own picker, and is not clipped by the chip row scrolling sideways on a narrow screen.
export function FilterChips({ filter, onChange, waiting, className }: { filter: BoardFilter; onChange: (f: BoardFilter) => void; waiting: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div role="group" aria-label="Filter cards" className={cx("flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      <Toggle pressed={filter.mine} onClick={() => onChange({ ...filter, mine: !filter.mine })}>
        Mine
      </Toggle>
      <Toggle pressed={filter.needsMe} onClick={() => onChange({ ...filter, needsMe: !filter.needsMe })}>
        Needs me
        {waiting > 0 ? (
          <span className={cx("font-mono text-[11px]", filter.needsMe ? "text-accent" : "text-warn")} aria-label={`${waiting} waiting`}>
            {waiting}
          </span>
        ) : null}
      </Toggle>
      <label className={cx(chip, "relative pr-1.5", filter.priority ? chipOn : chipOff)}>
        <span className="sr-only">Priority</span>
        <select
          value={filter.priority ?? ""}
          onChange={(e) => onChange({ ...filter, priority: (e.target.value || null) as Priority | null })}
          className="h-full cursor-pointer appearance-none bg-transparent pr-4 focus:outline-none"
        >
          <option value="">Any priority</option>
          {[...PRIORITIES].reverse().map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </label>
      <AnimatePresence initial={false}>
        {filterActive(filter) ? (
          <motion.button
            key="clear"
            type="button"
            initial={reduce ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => onChange(NO_FILTER)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-control px-2 text-[12.5px] text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="size-3.5" strokeWidth={2} />
            Clear
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
