import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { cx, fieldClass } from "./ui";
import { moveHighlight, placeList, typeahead, type ListPlacement } from "../lib/listbox";

export type SelectOption<T extends string> = { value: T; label: string; icon?: ReactNode };

/**
 * A dropdown the app draws itself, in place of the browser's own `<select>`. The list opens in a layer
 * of its own above the page, placed against the button, so a dialog or a row that scrolls sideways
 * cannot clip it. Focus stays on the button while the list is open and the highlighted option is
 * announced through `aria-activedescendant`, as in the WAI-ARIA select-only combobox pattern, which
 * also keeps focus inside a dialog or the card sheet. Arrows, Home, End, and the page keys move the
 * highlight; Enter or Space picks; Escape closes; typing jumps to an option.
 *
 * `look="field"` is a form field the width of its container; `look="bare"` leaves the button's look
 * to `className`, as the board's filter chips do.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
  look = "field",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  label: string;
  disabled?: boolean;
  look?: "field" | "bare";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [place, setPlace] = useState<ListPlacement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const handledKeyAt = useRef(0);
  const id = useId();
  const reduce = useReducedMotion();
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];
  // When some options have an icon, the rest keep its room, so the labels line up.
  const iconRoom = options.some((o) => o.icon);
  const optionId = (i: number) => `${id}-option-${i}`;

  const show = (at = selectedIndex) => {
    if (disabled) return;
    setHighlight(at);
    setPlace(null);
    setOpen(true);
    // Safari does not focus a button on click, and the keys only work while it has focus.
    button.current?.focus();
  };
  const choose = (i: number) => {
    const option = options[i];
    if (option && option.value !== value) onChange(option.value);
    setOpen(false);
  };

  // Placed before the first paint, then again whenever anything scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!button.current || !list.current) return;
      setPlace(placeList(button.current.getBoundingClientRect(), { height: list.current.scrollHeight, width: list.current.offsetWidth }, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Captured on window and stopped there, so the Escape that closes the list does not also close a
    // dialog or card sheet underneath.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && place) document.getElementById(optionId(highlight))?.scrollIntoView({ block: "nearest" });
  }, [open, place, highlight]);

  // Typed text gathers for half a second, then starts over.
  const typeTo = (char: string, from: number): number => {
    const now = performance.now();
    typed.current = { text: now - typed.current.at < 500 ? typed.current.text + char : char, at: now };
    return typeahead(
      options.map((o) => o.label),
      typed.current.text,
      from,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const printable = e.key.length === 1 && e.key !== " ";
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") show();
      else if (e.key === "Home") show(0);
      else if (e.key === "End") show(options.length - 1);
      else if (printable) {
        const at = typeTo(e.key, selectedIndex);
        show(at >= 0 ? at : selectedIndex);
      } else return;
    } else if (e.key === "Enter" || e.key === " ") {
      choose(highlight);
    } else if (e.key === "Tab") {
      setOpen(false);
      return;
    } else {
      const moved = moveHighlight(e.key, highlight, options.length);
      if (moved !== null) setHighlight(moved);
      else if (printable) {
        const at = typeTo(e.key, highlight);
        if (at >= 0) setHighlight(at);
      } else return;
    }
    e.preventDefault();
    e.stopPropagation();
    handledKeyAt.current = performance.now();
  };

  // A click the keyboard made (detail 0) right after a key already handled here is that key's echo;
  // any other click, a screen reader's included, toggles the list.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0 && performance.now() - handledKeyAt.current < 500) return;
    if (open) setOpen(false);
    else show();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? optionId(highlight) : undefined}
        disabled={disabled}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={cx(
          look === "field" ? cx(fieldClass, "flex h-9 cursor-pointer items-center gap-2 pr-2.5 text-left", open && "border-accent/60") : "cursor-pointer",
          className,
        )}
      >
        <span className={cx("flex min-w-0 items-center gap-1.5", look === "field" && "flex-1")}>
          {look === "field" ? selected?.icon : null}
          <span className="truncate">{selected?.label}</span>
        </span>
        <ChevronDown className={cx("size-3.5 shrink-0 transition-transform duration-200 ease-out-expo", look === "field" && "text-ink-faint", open && "rotate-180")} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={list}
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              // The button keeps focus: a press on the list must not take it away.
              onMouseDown={(e) => e.preventDefault()}
              initial={reduce ? false : { opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              style={
                place
                  ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight, minWidth: place.minWidth, transformOrigin: place.up ? "bottom" : "top" }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
              className="fixed z-[80] overflow-y-auto overscroll-contain rounded-card border border-line-strong bg-raised p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
            >
              {options.map((o, i) => {
                const isSelected = o.value === value;
                return (
                  <div
                    key={o.value}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isSelected}
                    onPointerMove={() => setHighlight(i)}
                    onClick={() => choose(i)}
                    className={cx(
                      "flex cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-[8px] py-1.5 pl-2.5 pr-2 text-[13px] transition-colors duration-100",
                      i === highlight ? "bg-overlay text-ink" : isSelected ? "text-ink" : "text-ink-muted",
                    )}
                  >
                    {o.icon ?? (iconRoom ? <span className="size-3.5 shrink-0" aria-hidden="true" /> : null)}
                    <span className="flex-1">{o.label}</span>
                    <Check className={cx("size-3.5 shrink-0 text-accent", !isSelected && "invisible")} strokeWidth={2} aria-hidden="true" />
                  </div>
                );
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
