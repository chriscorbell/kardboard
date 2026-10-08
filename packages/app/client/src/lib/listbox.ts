// The keyboard and placement rules of a dropdown list, kept apart from the component so they can be
// tested on their own. They follow the WAI-ARIA select-only combobox pattern.

/** Where the highlight goes for a navigation key, or null when the key is not one. It stops at the ends rather than wrapping. */
export function moveHighlight(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.min(last, at + 1);
    case "ArrowUp":
      return Math.max(0, at - 1);
    case "PageDown":
      return Math.min(last, at + 10);
    case "PageUp":
      return Math.max(0, at - 10);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * The option that typed text picks: the next label after `from` starting with it, ignoring case. One
 * character, or the same character typed again and again, moves on to the next label with that
 * initial; longer text matches from `from` itself, so typing on narrows the match. -1 when none does.
 */
export function typeahead(labels: readonly string[], query: string, from: number): number {
  const q = query.toLowerCase();
  if (!q || labels.length === 0) return -1;
  const repeated = [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0]! : q;
  const start = repeated ? from + 1 : from;
  for (let k = 0; k < labels.length; k++) {
    const i = (((start + k) % labels.length) + labels.length) % labels.length;
    if (labels[i]!.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export type ListPlacement = { left: number; top?: number; bottom?: number; maxHeight: number; minWidth: number; up: boolean };

/**
 * Where a list opens against the button that opened it, in viewport pixels for `position: fixed`:
 * below the button, or above it when the list does not fit below and there is more room above. The
 * list is at least as wide as the button, kept `margin` from the viewport's edges, and scrolls when
 * taller than the room it has.
 */
export function placeList(
  anchor: { top: number; bottom: number; left: number; width: number },
  list: { height: number; width: number },
  viewport: { width: number; height: number },
  gap = 4,
  margin = 8,
): ListPlacement {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const up = list.height > below && above > below;
  const maxHeight = Math.max(0, Math.min(list.height, up ? above : below));
  const width = Math.max(list.width, anchor.width);
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - margin - width));
  return up
    ? { left, bottom: viewport.height - anchor.top + gap, maxHeight, minWidth: anchor.width, up }
    : { left, top: anchor.bottom + gap, maxHeight, minWidth: anchor.width, up };
}
