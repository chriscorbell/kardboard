type Placed = { id: string; position: number };

// Where a dragged card lands. `target` is the destination column in display order; it includes the
// dragged card when the card moves within its own column. `overId` is the card it was dropped on,
// or null for the column itself, which means the end.
//
// Dropped on a card in its own column, the dragged card takes that card's index, as the sortable
// preview showed it (dnd-kit's arrayMove). Dropped on a card in another column, it goes before it.
// Either way that index is counted in the column without the dragged card, which is where the new
// position is computed. Returns null when the card would stay where it is.
export function dropPlacement(target: readonly Placed[], activeId: string, overId: string | null): { index: number; position: number } | null {
  const from = target.findIndex((c) => c.id === activeId);
  const lane = target.filter((c) => c.id !== activeId);
  let index = lane.length;
  if (overId !== null) {
    const over = target.findIndex((c) => c.id === overId);
    if (over >= 0) index = over;
  }
  if (from >= 0 && index === from) return null;
  const before = lane[index - 1]?.position;
  const after = lane[index]?.position;
  let position: number;
  if (before === undefined && after === undefined) position = 1000;
  else if (before === undefined) position = after! - 1000;
  else if (after === undefined) position = before + 1000;
  else position = (before + after) / 2;
  return { index, position };
}
