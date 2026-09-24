import type { Column } from "@kardboard/shared";

export const COLUMN_TONES: Record<Column, "neutral" | "accent" | "ok" | "warn" | "danger" | "info"> = {
  inbox: "neutral",
  blocked: "warn",
  ready: "info",
  in_progress: "accent",
  review: "accent",
  done: "ok",
};

export const COLUMN_HINTS: Record<Column, string> = {
  inbox: "New requests. Milo picks these up within a minute.",
  blocked: "Waiting on an answer from a person.",
  ready: "Triaged and waiting for a free session.",
  in_progress: "A session is implementing this now.",
  review: "A preview is ready. Approve to merge.",
  done: "Merged, closed, or a duplicate.",
};
