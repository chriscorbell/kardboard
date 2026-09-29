import type { Column } from "@kardboard/shared";

export const COLUMN_TONES: Record<Column, "neutral" | "accent" | "ok" | "warn" | "danger" | "info"> = {
  inbox: "neutral",
  blocked: "warn",
  ready: "info",
  in_progress: "accent",
  review: "accent",
  done: "ok",
};

// Shown in an empty column. The Agent is named as the Admin named it, not as it was first called.
// Without sessions nothing on the Board moves by itself, so nothing here promises that it will.
export function columnHint(column: Column, agentName: string, sessionsEnabled: boolean): string {
  if (!sessionsEnabled) return QUIET_HINTS[column];
  return {
    inbox: `New requests. ${agentName} picks these up within a minute.`,
    blocked: "Waiting on an answer from a person.",
    ready: "Triaged and waiting for a free session.",
    in_progress: "A session is implementing this now.",
    review: "A preview is ready. Approve to merge.",
    done: "Merged, closed, or a duplicate.",
  }[column];
}

const QUIET_HINTS: Record<Column, string> = {
  inbox: "New requests, not looked at yet.",
  blocked: "Waiting on an answer from a person.",
  ready: "Triaged and waiting to be started.",
  in_progress: "Being worked on now.",
  review: "A pull request is open for a look.",
  done: "Merged, closed, or a duplicate.",
};
