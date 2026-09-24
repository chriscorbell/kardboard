import { useEffect, type RefObject } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

// Focus for a modal surface. While `active`, Tab and Shift+Tab stay inside `ref`, and when it ends
// focus goes back to whatever had it before, usually the control that opened it. Focus moves in on
// open and again whenever `resetKey` changes: to the first form field, or with `initial: "container"`
// to the surface itself, for a long panel that should be announced by name before its first control.
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean, { initial = "field", resetKey }: { initial?: "field" | "container"; resetKey?: unknown } = {}) {
  useEffect(() => {
    if (!active) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== "Tab" || !root || e.defaultPrevented) return;
      const items = focusablesIn(root);
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        root.focus();
      } else if (!root.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [active, ref]);

  useEffect(() => {
    if (!active) return;
    // A frame later, so an element's own autoFocus has run and the entry animation has a layout.
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const target = initial === "container" ? root : (root.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])') ?? focusablesIn(root)[0] ?? root);
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, ref, initial, resetKey]);
}
