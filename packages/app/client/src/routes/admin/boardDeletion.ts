import type { BoardDeletionImpact } from "@kardboard/shared";

// The decisions behind the Delete board dialog, kept out of the component so they can be tested.

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What deleting the Board takes with it, as a phrase: "3 cards, 12 comments and 1 attachment". Null when it holds nothing. */
export function deletionContents(impact: BoardDeletionImpact): string | null {
  const parts = [
    impact.cards > 0 ? count(impact.cards, "card") : null,
    impact.comments > 0 ? count(impact.comments, "comment") : null,
    impact.attachments > 0 ? count(impact.attachments, "attachment") : null,
    impact.previews > 0 ? count(impact.previews, "preview") : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Delete may be pressed once the impact is known, nothing is running, and the slug is typed exactly. */
export function canDelete(impact: BoardDeletionImpact | undefined, typed: string, slug: string): boolean {
  return impact !== undefined && impact.activeSessions === 0 && typed.trim() === slug;
}
