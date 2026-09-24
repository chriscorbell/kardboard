// Short-lived messages for things that failed out of sight: a drag the server refused, a priority
// that did not save. Anything that fails where a person is already looking reports inline instead.
export type Toast = { id: number; message: string };

const LIFETIME_MS = 6000;
// Older messages give way rather than stacking up the screen.
const MAX_SHOWN = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function toast(message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, message }].slice(-MAX_SHOWN);
  emit();
  setTimeout(() => dismissToast(id), LIFETIME_MS);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// For useSyncExternalStore: the list only changes identity when it changes.
export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentToasts(): Toast[] {
  return toasts;
}
