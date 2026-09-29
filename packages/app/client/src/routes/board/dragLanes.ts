import type { Column } from "@kardboard/shared";

// The card ids each column shows, in order, while a card is dragged. The dragged card moves between
// lanes as the pointer crosses columns, so the column it would land in opens a gap for it.
export type Lanes = Record<Column, string[]>;

const COLUMN_PREFIX = "col:";

/** A column's own droppable id, as `useDroppable` registers it. */
export function columnDropId(column: Column): string {
  return `${COLUMN_PREFIX}${column}`;
}

/** The column an id belongs to: a column's own droppable, or the lane holding a card. */
export function laneOf(lanes: Lanes, id: string): Column | null {
  if (id.startsWith(COLUMN_PREFIX)) return id.slice(COLUMN_PREFIX.length) as Column;
  for (const column of Object.keys(lanes) as Column[]) if (lanes[column].includes(id)) return column;
  return null;
}

/**
 * The dragged card crossing into another column: taken from its lane and put in the target's, before
 * the card it is over, or after it when the pointer is past that card's middle, or last when it is
 * over the column itself. Null while it stays in its own lane, where sorting handles it.
 */
export function moveAcross(lanes: Lanes, activeId: string, overId: string, pastMiddle: boolean): Lanes | null {
  const from = laneOf(lanes, activeId);
  const to = laneOf(lanes, overId);
  if (!from || !to || from === to) return null;
  const target = lanes[to];
  const over = target.indexOf(overId);
  const index = over < 0 ? target.length : over + (pastMiddle ? 1 : 0);
  return { ...lanes, [from]: lanes[from].filter((id) => id !== activeId), [to]: [...target.slice(0, index), activeId, ...target.slice(index)] };
}

/** The drop within one lane: the dragged card takes the index of the card it is over, as the sorting preview showed. */
export function settleWithin(lanes: Lanes, activeId: string, overId: string): Lanes {
  const lane = laneOf(lanes, activeId);
  if (!lane || laneOf(lanes, overId) !== lane) return lanes;
  const ids = lanes[lane];
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return lanes;
  const next = ids.filter((id) => id !== activeId);
  next.splice(to, 0, activeId);
  return { ...lanes, [lane]: next };
}

/** Where the dragged card sits in the lanes: its column, and the card after it, or null at the end. */
export function dropSpot(lanes: Lanes, activeId: string): { column: Column; beforeId: string | null } | null {
  const column = laneOf(lanes, activeId);
  if (!column) return null;
  const ids = lanes[column];
  return { column, beforeId: ids[ids.indexOf(activeId) + 1] ?? null };
}

type Placed = { id: string; position: number };

/**
 * The position for a card placed just before `beforeId` in `column`, or last when that is null.
 * `column` is every card in the destination in board order, those a filter or the folded Done hides
 * included, so the position cannot land on a hidden card's.
 */
export function placeBefore(column: readonly Placed[], activeId: string, beforeId: string | null): number {
  const lane = column.filter((c) => c.id !== activeId);
  const found = beforeId === null ? -1 : lane.findIndex((c) => c.id === beforeId);
  const index = found < 0 ? lane.length : found;
  const before = lane[index - 1]?.position;
  const after = lane[index]?.position;
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}
