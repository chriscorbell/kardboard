import { cloneElement, isValidElement, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cx } from "./ui";
import { FOCUSABLE } from "./focus";

// A trigger and a panel that closes on an outside click or Escape. The Menu and the notification
// panel share it so they open, animate, and dismiss the same way.
export function Popover({
  trigger,
  align = "left",
  className,
  role = "dialog",
  onOpen,
  children,
}: {
  trigger: ReactNode;
  align?: "left" | "right";
  className?: string;
  role?: string;
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerBox = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const isMenu = role === "menu";

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerBox.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured on window and stopped there, so the Escape that closes this panel does not also
    // reach a card sheet or dialog underneath and close that too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // A menu takes focus on its first item, so the arrow keys work at once.
  useEffect(() => {
    if (open && isMenu) menuItems(panel.current)[0]?.focus();
  }, [open, isMenu]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = menuItems(panel.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  const labelled = isValidElement<Record<string, unknown>>(trigger) ? cloneElement(trigger, { "aria-haspopup": isMenu ? "menu" : "dialog", "aria-expanded": open }) : trigger;

  return (
    <div
      ref={ref}
      className="relative"
      onBlur={(e) => {
        // Tabbing away closes it; a click elsewhere is handled by the mousedown listener.
        if (open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div
        ref={triggerBox}
        onClick={() => {
          setOpen((o) => {
            if (!o) onOpen?.();
            return !o;
          });
        }}
      >
        {labelled}
      </div>
      <AnimatePresence>
        {open ? (
          <motion.div
            ref={panel}
            role={role}
            onKeyDown={isMenu ? onMenuKey : undefined}
            initial={reduce ? false : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={cx(
              "absolute top-full z-50 mt-1 overflow-hidden rounded-card border border-line-strong bg-raised shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]",
              align === "right" ? "right-0" : "left-0",
              className,
            )}
          >
            {children(() => close(isMenu))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function menuItems(panel: HTMLElement | null): HTMLElement[] {
  return panel ? [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')] : [];
}
