import type { Column } from "@kardboard/shared";

export const COLUMN_TONES: Record<Column, "neutral" | "accent" | "ok" | "warn" | "danger" | "info"> = {
  inbox: "neutral",
  blocked: "warn",
  ready: "info",
  in_progress: "accent",
  review: "accent",
  done: "ok",
};

// Shown in an empty column, and beside each column in the board explainer. Nothing on the Board
// moves by itself, so nothing here promises that it will.
export function columnHint(column: Column): string {
  return COLUMN_HINTS[column];
}

const COLUMN_HINTS: Record<Column, string> = {
  inbox: "New requests, not looked at yet.",
  blocked: "Waiting on your answer.",
  ready: "Triaged and waiting to be started.",
  in_progress: "Being worked on now.",
  review: "A pull request is open for a look.",
  done: "Merged, closed, or a duplicate.",
};
