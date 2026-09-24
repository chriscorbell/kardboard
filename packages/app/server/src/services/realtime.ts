import type { BoardEvent } from "@kardboard/shared";

type Listener = (event: BoardEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(boardId: string, fn: Listener): () => void {
  let set = listeners.get(boardId);
  if (!set) {
    set = new Set();
    listeners.set(boardId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(boardId);
  };
}

export function publish(boardId: string, event: BoardEvent): void {
  const set = listeners.get(boardId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      // a broken subscriber must not break the others
    }
  }
}
