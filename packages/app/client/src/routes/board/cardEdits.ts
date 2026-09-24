import type { Card } from "@kardboard/shared";

export type EditableField = "title" | "description";

// What the field held, and the Card's revision, when the person started editing it.
export type EditBase = { revision: number; value: string };

export class EditConflict extends Error {
  constructor(public card: Card) {
    super("Someone else changed this card while you were editing.");
    this.name = "EditConflict";
  }
}

// A save names the revision its edit started from, and the server refuses it with the latest Card
// when the revision has moved on. Every change bumps it, a Session moving the Card included, so the
// refusal is only a conflict when this field changed. Otherwise the save can go again on top.
export function resolveRefusedSave(field: EditableField, base: EditBase, latest: Card | undefined): { retryAt: number } | { conflict: Card } | null {
  if (!latest) return null;
  if (latest[field] === base.value) return { retryAt: latest.revision };
  return { conflict: latest };
}
