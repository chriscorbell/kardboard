import { useSyncExternalStore } from "react";

// A touch screen as the main pointer: a phone, or a tablet without a trackpad. Its keyboard has no
// Shift+Enter, and there is no hover to reveal a control.
const COARSE = "(pointer: coarse)";

function subscribe(fn: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COARSE);
  query.addEventListener("change", fn);
  return () => query.removeEventListener("change", fn);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.(COARSE).matches),
    () => false,
  );
}
